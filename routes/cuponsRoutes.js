const express = require('express');
const router = express.Router();
const cuponsController = require('../controllers/cuponsController');

router.get('/cupons', cuponsController.listarCupons);
router.delete('/cupons/:nome', cuponsController.apagarCupom);
router.get('/cupons-view', cuponsController.listarCuponsView);


module.exports = router;
