const express = require('express');
const sessions = require('express-session');
// Environment variables:
const HTTP_PORT = process.env.HTTP_PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET;
const HANDLER_DELAY_MS = Number(process.env.HANDLER_DELAY_MS || 10000);

function delay(durationMS) {
    return new Promise(function(resolve) {
        setTimeout(resolve, durationMS);
    });
}

const app = express();
app.use(sessions({
    saveUninitialized: false,
    resave: false,
    secret: SESSION_SECRET
}));

app.post('/add-to-cart/:item', async function(req, res) {
    const item = req.params.item;
    if (!req.session.cart) {
        req.session.cart = {};
    }
    // Simulate doing some time-consuming work - fetching prices, reserving wares in stock, etc.
    await delay(HANDLER_DELAY_MS);
    req.session.cart[item] = (req.session.cart[item] || 0) + 1;
    res.json({
        shoppingCart: req.session.cart
    });
});

app.get('/cart', function(req, res) {
    res.json({
        shoppingCart: req.session.cart
    });
});

app.listen(HTTP_PORT);
