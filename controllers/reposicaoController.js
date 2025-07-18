const path = require('path');
const { supabase } = require('../models/supabaseClient');
const normalizeQuiosque = require('../helpers/normalizeQuiosque');
const fs = require('fs')

async function getQuiosqueIdPorNome(nomeQuiosque) {
  const { data, error } = await supabase
    .from('quiosques')
    .select('id')
    .eq('nome', nomeQuiosque)
    .single();

  if (error || !data) throw new Error(`Quiosque '${nomeQuiosque}' não encontrado.`);
  return data.id;
}

exports.renderReposicaoPage = (req, res) => {
  if (!req.session.user) return res.redirect('/');
  res.render('reposicao', { user: req.session.user });
};

exports.renderReposicaoPageMobile = (req, res) => {
  if (!req.session.user) return res.redirect('/');
  res.render('reposicao-mobile', { user: req.session.user });
};

exports.salvarReposicao = async (req, res) => {
  const { dados, quiosque } = req.body;
  const nomeQuiosque = quiosque || req.session?.user?.quiosque;

  if (!nomeQuiosque || !dados) {
    return res.status(400).json({ status: 'erro', mensagem: 'Quiosque ou dados ausentes' });
  }

  try {
    const quiosqueId = await getQuiosqueIdPorNome(nomeQuiosque);

    // Apagar TODAS as reposições pendentes (e bipagens associadas) para o quiosque
    const { error: deleteError } = await supabase
      .from('reposicoes_planejadas')
      .delete()
      .match({ quiosque_id: quiosqueId, status: 'pendente' });

    if (deleteError) throw deleteError;

    // Inserir as novas reposições
    const insertData = Object.entries(dados).map(([sku, quantidade]) => ({
      quiosque_id: quiosqueId,
      sku: sku.toLowerCase(),
      quantidade_planejada: quantidade,
      status: 'pendente'
    }));

    const { error: insertError } = await supabase
      .from('reposicoes_planejadas')
      .insert(insertData);

    if (insertError) throw insertError;

    res.json({ status: 'ok', mensagem: `Reposição sobrescrita com sucesso para o quiosque ${nomeQuiosque}.` });
  } catch (err) {
    console.error('Erro ao sobrescrever reposição:', err.message);
    res.status(500).json({ status: 'erro', mensagem: 'Erro ao sobrescrever reposição no banco.' });
  }
};


exports.biparSku = async (req, res) => {
  let { sku, quiosque, mobile } = req.body;

  if (!quiosque || !sku) {
    return res.status(400).json({ status: 'erro', mensagem: 'Quiosque ou SKU não enviados' });
  }

  try {
    let quiosqueId = isNaN(Number(quiosque))
      ? await getQuiosqueIdPorNome(quiosque)
      : Number(quiosque);

    sku = sku.toLowerCase();

    const { data: reposicaoData, error: reposicaoError } = await supabase
      .from('reposicoes_planejadas')
      .select('id, quantidade_planejada')
      .eq('quiosque_id', quiosqueId)
      .eq('sku', sku)
      .eq('status', 'pendente')
      .order('id', { ascending: false })
      .limit(1);

    if (reposicaoError) throw reposicaoError;

    if (mobile && (!reposicaoData || reposicaoData.length === 0)) {
      return res.status(400).json({
        status: 'erro',
        mensagem: `SKU '${sku}' não está na lista de reposição pendente para o quiosque '${quiosque}'.`
      });
    }

    const reposicaoId = reposicaoData?.[0]?.id;

    let quantidadeIncremento = 1;

    const incremento5 = ['prendedor menina', 'prendedor menino'];
    const incremento10 = ['roupa', 'maternidade', 'bolsa', 'laco', 'manta', 'sacola'];
    const incremento20 = ['kit'];

    if (incremento5.some(term => sku.includes(term))) {
      quantidadeIncremento = 5;
    } else if (incremento10.some(term => sku.includes(term))) {
      quantidadeIncremento = 10;
    } else if (incremento20.some(term => sku.includes(term))) {
      quantidadeIncremento = 20;
    }

    // Registra bipagem (se tiver reposição associada)
    if (reposicaoId) {
      await supabase.from('bipagens_reposicao').insert([
        {
          reposicao_id: reposicaoId,
          operador: req.session.user?.username || 'desconhecido'
        }
      ]);
    }

    // Busca quantidade atual do estoque (se existir)
    const { data: atualEstoque, error: erroBusca } = await supabase
      .from('estoque_quiosque')
      .select('quantidade')
      .eq('quiosque_id', quiosqueId)
      .eq('sku', sku)
      .single();

    if (erroBusca && erroBusca.code !== 'PGRST116') throw erroBusca;

    const quantidadeAtual = atualEstoque?.quantidade || 0;
    const novaQuantidade = quantidadeAtual + quantidadeIncremento;

    // Atualiza estoque somando
    const { error: erroUpdate } = await supabase
      .from('estoque_quiosque')
      .upsert({
        quiosque_id: quiosqueId,
        sku,
        quantidade: novaQuantidade
      }, { onConflict: ['quiosque_id', 'sku'], ignoreDuplicates: false });

    if (erroUpdate) throw erroUpdate;

    // RETORNA A QUANTIDADE TOTAL ATUALIZADA, NÃO APENAS O INCREMENTO
    const atual = { [sku]: novaQuantidade };

    res.json({
      status: 'ok',
      mensagem: `SKU '${sku}' registrado para o quiosque '${quiosque}' (+${quantidadeIncremento} unidades).`,
      atual
    });

  } catch (err) {
    console.error("Erro ao bipar SKU:", err.message);
    res.status(500).json({ status: 'erro', mensagem: 'Erro ao atualizar estoque.' });
  }
};


exports.renderReposicao = async (req, res) => {
  try {
    const { data: quiosques, error: errorQuiosques } = await supabase
      .from('quiosques')
      .select('nome')
      .order('nome');

    if (errorQuiosques) throw errorQuiosques;

    // Buscar SKUs para autocomplete
    const { data: skusDisponiveis, error: errorSkus } = await supabase
      .from('precos')  // sua tabela onde tem sku, preço, etc
      .select('sku')
      .order('sku');

    if (errorSkus) throw errorSkus;

    // Extrair só os skus em array de strings
    const listaSkus = skusDisponiveis.map(item => item.sku);

    res.render('reposicao-bonecas', { quiosques, skusDisponiveis: listaSkus });
  } catch (err) {
    console.error("Erro ao carregar dados para reposição:", err.message);
    res.status(500).send("Erro ao carregar dados para reposição");
  }
};


exports.getReposicaoBanco = async (req, res) => {
  const quiosque = req.params.quiosque;

  try {
    const quiosqueId = await getQuiosqueIdPorNome(quiosque);

    const { data, error } = await supabase
      .from('reposicoes_planejadas')
      .select('sku, quantidade_planejada')
      .eq('quiosque_id', quiosqueId)
      .eq('status', 'pendente'); // só pendentes

    if (error) throw error;

    const dados = {};
    data.forEach(row => {
      dados[row.sku.toLowerCase()] = row.quantidade_planejada;
    });

    res.json({ dados });
  } catch (err) {
    console.error("Erro ao buscar reposição do banco:", err.message);
    res.status(500).json({ error: "Erro ao buscar reposição do banco" });
  }
};

exports.finalizarReposicao = async (req, res) => {
  const { quiosque_id, quiosque } = req.body;

  try {
    let idQuiosque = quiosque_id;

    if (!idQuiosque && quiosque) {
      idQuiosque = await getQuiosqueIdPorNome(quiosque);
    }

    if (!idQuiosque) {
      return res.status(400).json({ status: 'erro', mensagem: 'ID do quiosque não informado' });
    }

    // Atualiza status para finalizada
    const { error } = await supabase
      .from('reposicoes_planejadas')
      .update({ status: 'finalizada' })
      .eq('quiosque_id', idQuiosque)
      .eq('status', 'pendente');

    if (error) throw error;

    res.json({ status: 'ok', mensagem: `Reposição do quiosque ID '${idQuiosque}' finalizada.` });
  } catch (err) {
    console.error("Erro ao finalizar reposição:", err);
    res.status(500).json({
      status: 'erro',
      mensagem: 'Erro ao finalizar reposição.',
      detalhe: err.message || JSON.stringify(err)
    });
  }
};

exports.resetarReposicao = async (req, res) => {
  const { quiosque } = req.body;
  if (!quiosque) return res.status(400).json({ status: 'erro', mensagem: 'Quiosque não informado' });

  try {
    const quiosqueId = await getQuiosqueIdPorNome(quiosque);

    const { error } = await supabase
      .from('reposicoes_planejadas')
      .update({ status: 'pendente' })
      .eq('quiosque_id', quiosqueId);

    if (error) throw error;

    res.json({ status: 'ok', mensagem: `Reposição do quiosque '${quiosque}' resetada com sucesso.` });
  } catch (err) {
    console.error("Erro ao resetar reposição:", err);
    res.status(500).json({ status: 'erro', mensagem: 'Erro ao resetar reposição.' });
  }
};

exports.getEstoquePorQuiosque = async (req, res) => {
  const nome = req.params.nome;

  try {
    const quiosqueId = await getQuiosqueIdPorNome(nome);

    const { data, error } = await supabase
      .from('estoque_quiosque')
      .select('sku, quantidade')
      .eq('quiosque_id', quiosqueId)
      .order('sku');

    if (error) throw error;

    const estoque = {};
    data.forEach(item => {
      estoque[item.sku] = item.quantidade;
    });

    res.json({ estoque });
  } catch (err) {
    console.error("Erro ao buscar estoque:", err.message);
    res.status(500).json({ erro: 'Erro ao buscar estoque' });
  }
};
