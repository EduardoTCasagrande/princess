const { supabase } = require('../models/supabaseClient');
const path = require('path');
const fs = require('fs');
const { DateTime } = require('luxon'); // ← para timezone Brasília
const axios = require('axios');


exports.vendasPage = (req, res) => {
  if (!req.session.user) return res.redirect('/');
  res.render('vendas');
};

exports.vender = async (req, res) => {
  const {
    quiosque_id,
    venda,
    pagamentos,
    total,
    desconto,
    operador,
    itensPromocionais
  } = req.body;

  if (!quiosque_id || !venda || typeof venda !== 'object' || !Array.isArray(pagamentos) || typeof total !== 'number') {
    return res.status(400).json({ status: 'erro', mensagem: 'Dados da venda inválidos.' });
  }

  try {
    const agora = DateTime.now().setZone('America/Sao_Paulo').toISO();

    // Buscar último ID de venda
    const { data: ultimas, error: errUltimo } = await supabase
      .from('historico_transacoes')
      .select('id_venda')
      .order('id_venda', { ascending: false })
      .limit(1);

    if (errUltimo) throw errUltimo;
    const idVendaAtual = (ultimas?.[0]?.id_venda || 0) + 1;

    const skus = Object.entries(venda).filter(([sku, qtd]) => sku && qtd && qtd > 0);
    const vendaDetalhada = [];

    for (const [sku, quantidade] of skus) {
      // Buscar preço
      const { data: precoData, error: precoErr } = await supabase
        .from('precos')
        .select('preco')
        .eq('sku', sku)
        .single();
      if (precoErr) throw precoErr;

      let precoUnitario = precoData?.preco || 0;

      // Aplicar promoção
      if (itensPromocionais && itensPromocionais[sku]) {
        precoUnitario = 0.01;
      }

      const valorTotalItem = precoUnitario * quantidade;
      vendaDetalhada.push({ sku, quantidade, precoUnitario, valorTotalItem });

      // Atualizar estoque via função
      await supabase.rpc('atualizar_estoque_venda', {
        p_quiosque_id: quiosque_id,
        p_sku: sku,
        p_quantidade: quantidade
      });

      // Inserir no histórico de transações
      const { error: insertHistErr } = await supabase
        .from('historico_transacoes')
        .insert([{
          id_venda: idVendaAtual,
          tipo: 'venda',
          quiosque_id,
          sku,
          quantidade,
          valor: valorTotalItem,
          operador: operador || 'desconhecido',
          data: agora
        }]);

      if (insertHistErr) throw insertHistErr;
    }

    // Registrar pagamentos com id_venda incluído
    const pagamentosInsert = pagamentos.map(p => ({
      quiosque_id,
      valor: p.valor,
      forma_pagamento: p.forma.toLowerCase(),
      data: agora,
      id_venda: idVendaAtual  // <== importante!
    }));

    const { error: caixaErr } = await supabase
      .from('caixa_movimentos')
      .insert(pagamentosInsert);

    if (caixaErr) throw caixaErr;

    const nomeArquivo = gerarCupomESC(quiosque_id, vendaDetalhada, total, desconto, pagamentos, operador, idVendaAtual);

    res.json({
      status: 'ok',
      mensagem: `Venda #${idVendaAtual} finalizada com sucesso.`,
      id_venda: idVendaAtual,
      cupomUrl: `/cupons/${nomeArquivo}`
    });
  } catch (err) {
    console.error('Erro ao processar venda:', err);
    res.status(500).json({ status: 'erro', mensagem: 'Erro interno ao processar venda.' });
  }
};

function gerarCupomESC(quiosque_id, itens, total, desconto, pagamentos, operador, idVendaAtual) {
  const cuponsDir = path.join(__dirname, '../cupons');
  if (!fs.existsSync(cuponsDir)) {
    fs.mkdirSync(cuponsDir);
  }

  const data = new Date();
  const nomeArquivo = `cupom_${quiosque_id}_${data.getTime()}.esc`;
  const filePath = path.join(cuponsDir, nomeArquivo);

  let conteudo = '';
  conteudo += '*** CUPOM PDV ***\n';
  conteudo += `Venda Nº: ${idVendaAtual}\n`;
  conteudo += `Quiosque ID: ${quiosque_id}\n`;
  conteudo += `Data: ${data.toLocaleString()}\n`;
  conteudo += `Operador: ${operador || 'desconhecido'}\n\n`;

  itens.forEach(item => {
    conteudo += `SKU: ${item.sku} | Qtd: ${item.quantidade} | R$: ${item.precoUnitario.toFixed(2)}\n`;
  });

  conteudo += `\nTotal: R$ ${total.toFixed(2)}\n`;
  if (desconto && desconto > 0) {
    conteudo += `Desconto: R$ ${desconto.toFixed(2)}\n`;
  }

  conteudo += '\nPagamentos:\n';
  pagamentos.forEach(p => {
    const forma = p.forma_pagamento || p.forma || 'forma desconhecida';
    conteudo += `- ${forma}: R$ ${p.valor.toFixed(2)}\n`;
  });

  conteudo += '\nObrigado pela preferência!\n';
  fs.writeFileSync(filePath, conteudo, 'utf8');
  return nomeArquivo;
}

exports.renderHistoricoPage = (req, res) => {
  if (!req.session.user) return res.redirect('/');
  res.render('historico');
};

exports.historico = async (req, res) => {
  const { data_inicio, data_fim, quiosque_id } = req.query;

  if (!data_inicio || !data_fim) {
    return res.status(400).json({
      status: 'erro',
      mensagem: 'Parâmetros "data_inicio" e "data_fim" são obrigatórios.'
    });
  }

  try {
    let query = supabase
      .from('historico_transacoes')
      .select('id_venda, data, sku, quantidade, valor, operador, quiosque_id, quiosques (nome)')
      .eq('tipo', 'venda')
      .gte('data', `${data_inicio}T00:00:00`)
      .lte('data', `${data_fim}T23:59:59`)
      .order('id_venda', { ascending: true });

    if (quiosque_id) {
      query = query.eq('quiosque_id', quiosque_id);
    }

    const { data, error } = await query;

    if (error) throw error;

    // Adiciona o nome do quiosque no resultado
    const historicoFormatado = data.map(item => ({
      ...item,
      quiosque_nome: item.quiosques?.nome || `ID ${item.quiosque_id}`
    }));

    res.json({ status: 'ok', historico: historicoFormatado });
  } catch (err) {
    console.error('Erro ao consultar histórico:', err);
    res.status(500).json({ status: 'erro', mensagem: 'Erro ao buscar histórico de vendas.' });
  }
};

exports.reimprimirCupom = async (req, res) => {
  const { id_venda, quiosque_id } = req.query;

  if (!id_venda || !quiosque_id) {
    return res.status(400).json({ status: 'erro', mensagem: 'Parâmetros ausentes.' });
  }

  try {
    // Busca todas as transações da venda
    const { data: transacoes, error: transErr } = await supabase
      .from('historico_transacoes')
      .select('sku, quantidade, valor, operador')
      .eq('id_venda', id_venda)
      .eq('quiosque_id', quiosque_id);

    if (transErr) throw transErr;
    if (!transacoes.length) {
      return res.status(404).json({ status: 'erro', mensagem: 'Venda não encontrada.' });
    }

    const vendaDetalhada = transacoes.map(t => ({
      sku: t.sku,
      quantidade: t.quantidade,
      precoUnitario: t.quantidade > 0 ? +(t.valor / t.quantidade).toFixed(2) : 0,
      valorTotalItem: t.valor
    }));

    const operador = transacoes[0].operador;

    // Busca os pagamentos dessa venda no caixa, filtrando pelo id_venda
    const { data: pagamentos, error: pgtoErr } = await supabase
      .from('caixa_movimentos')
      .select('valor, forma_pagamento')
      .eq('quiosque_id', quiosque_id)
      .eq('id_venda', id_venda)   // FILTRA PELO ID DA VENDA
      .order('data', { ascending: false });

    if (pgtoErr) throw pgtoErr;

    // Filtra só os métodos usados e formatados
    const pagamentosFiltrados = pagamentos
      .filter(p => ['dinheiro', 'pix', 'cartao'].includes(p.forma_pagamento.toLowerCase()));

    // Map para garantir propriedade forma_pagamento lowercase
    const pagamentosParaCupom = pagamentosFiltrados.map(p => ({
      valor: p.valor,
      forma_pagamento: p.forma_pagamento.toLowerCase()
    }));

    const total = vendaDetalhada.reduce((acc, i) => acc + i.valorTotalItem, 0);
    const desconto = 0;

    const nomeArquivo = gerarCupomESC(
      quiosque_id,
      vendaDetalhada,
      total,
      desconto,
      pagamentosParaCupom,
      operador,
      id_venda
    );

    res.json({ status: 'ok', cupomUrl: `/cupons/${nomeArquivo}` });

  } catch (err) {
    console.error('Erro ao reimprimir cupom:', err);
    res.status(500).json({ status: 'erro', mensagem: 'Erro ao gerar cupom.' });
  }
};

const api = axios.create({
  baseURL: 'https://api.nfse.io/v2',
  headers: {
    Authorization: 'Token 8bGbW5DsmBxFAMePxeSuofAM9zZ5HWRl9oR2KLhFH0hkpbBbDLJbBjyY4PLS6mWm0c0',
    'Content-Type': 'application/json'
  }
});

const companyId = '3c414721022b487ba7c34da19eb9bb87';

exports.emitirNotaFiscal = async (req, res) => {
  const { id_venda, quiosque_id, cliente } = req.body;
  console.log(id_venda, quiosque_id, cliente);

  if (!id_venda || !quiosque_id || !cliente) {
    return res.status(400).json({ status: 'erro', mensagem: 'Dados insuficientes para emissão da nota.' });
  }

  try {
    // Buscar itens da venda
    const { data: itens, error: itensErr } = await supabase
      .from('historico_transacoes')
      .select('sku, quantidade, valor')
      .eq('id_venda', id_venda)
      .eq('quiosque_id', quiosque_id);

    if (itensErr || !itens.length) throw itensErr || new Error('Venda não encontrada.');

    // Buscar formas de pagamento
    const { data: pagamentosData, error: pagamentosErr } = await supabase
      .from('caixa_movimentos')
      .select('forma_pagamento, valor')
      .eq('id_venda', id_venda)
      .eq('quiosque_id', quiosque_id);

    if (pagamentosErr) throw pagamentosErr;

    // Montar os itens da nota com tributação
    const itensNota = itens.map(item => {
      const unitAmount = +(item.valor / item.quantidade).toFixed(2);
      const totalAmount = +(unitAmount * item.quantidade).toFixed(2);

      return {
        code: item.sku,
        description: 'Bebê Reborn',
        quantity: item.quantidade,
        unit: 'UN',
        unitAmount,
        totalAmount,
        cfop: 5102,
        ncm: '95030021',
        cest: '',
        origin: '0',
        tax: {
          totalTax: 0.00,
          icms: {
            origin: '0',
            csosn: '102'
          },
          pis: {
            amount: 0.00,
            rate: 0.00,
            baseTax: 0.00,
            cst: '49'
          },
          cofins: {
            amount: 0.00,
            rate: 0.00,
            baseTax: 0.00,
            cst: '49'
          }
        }
      };
    });

    // Montar os pagamentos da nota
    const pagamentosNota = pagamentosData.map(p => ({
      type: p.forma_pagamento === 'pix' ? '17' : p.forma_pagamento === 'cartao' ? '03' : '01',
      value: Number(p.valor)
    }));

    // Montar payload final para envio
    const payload = {
      environment: 'production',
      operationNature: 'Venda de mercadoria',
      model: '65',
      items: itensNota,
      payments: pagamentosNota
    };

    if (cliente?.cpf) {
      payload.buyer = {
        name: cliente.nome,
        federalTaxNumber: cliente.cpf,
        stateTaxNumberIndicator: 'nonTaxPayer'
      };
    }


    const { data: nfceResp } = await api.post(
      `/companies/${companyId}/consumerinvoices?emit=true`,
      payload
    );

    console.log('✅ NFC-e emitida com sucesso:', nfceResp);
    res.json({ status: 'ok', mensagem: 'NFC-e emitida com sucesso!', nota: nfceResp });
  } catch (err) {
    console.error('❌ Erro ao emitir NFC-e:', err);
    const mensagem = err.response?.data || err.message || 'Erro desconhecido';
    res.status(500).json({ status: 'erro', mensagem });
  }
};



