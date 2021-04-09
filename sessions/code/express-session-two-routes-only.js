const express = require('express');
const sessions = require('express-session');
// Environment variables:
const HTTP_PORT = process.env.HTTP_PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET;

const app = express();
const sessionMiddleware = sessions({
    saveUninitialized: false,
    resave: false,
    secret: SESSION_SECRET
});

// Trigger this handler by e.g. POST /add-to-cart/mug.
// Example:
// fetch('/add-to-cart/mug', { method: 'POST', credentials: 'same-origin' });
app.post('/add-to-cart/:item', sessionMiddleware, function(req, res) {
    const item = req.params.item;
    if (!req.session.cart) {
        req.session.cart = {};
    }
    // Increment item quantity by 1, defaulting initial state to 0:
    req.session.cart[item] = (req.session.cart[item] || 0) + 1;
    res.json({
        shoppingCart: req.session.cart
    });
});

// A handler for inspecting the cart contents that does not modify the session object.
// Simply point the browser at http://localhost:3000/cart
app.get('/cart', sessionMiddleware, function(req, res) {
    res.json({
        shoppingCart: req.session.cart
    });
});

// A handler that tries to behave like /cart but fails because there is no session middleware:
app.get('/no-sessions', function(req, res) {
    res.json({
        shoppingCart: req.session.cart
    });
});

app.listen(HTTP_PORT);
