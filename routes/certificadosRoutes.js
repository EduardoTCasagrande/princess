const express = require('express');
const router = express.Router();

const certificatesController = require('../controllers/certificadosController');

router.get('/', certificatesController.listCertificates);

module.exports = router;
