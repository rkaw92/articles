const fastify = require('fastify');
const sessions = require('fastify-session');
const cookies = require('fastify-cookie');

// Environment variables:
const HTTP_PORT = process.env.HTTP_PORT || 3000;
// Note: the secret must be at least 32 characters long, as per fastify-session docs!
const SESSION_SECRET = process.env.SESSION_SECRET;

const app = fastify({
    logger: true
});
app.register(cookies);

// Note how we do not register the session middleware for the whole application,
//  but only within the scope in .register().

app.register(async function(scope) {
    scope.register(sessions, {
        secret: SESSION_SECRET,
        cookie: {
            // Note: this is for development only because we run on plain-text HTTP.
            // If you omit this option, session cookies will not work on localhost,
            //  unless you connect via an HTTPS reverse proxy.
            secure: false
        }
    });
    // Trigger this handler by e.g. POST /add-to-cart/mug.
    // Example:
    // fetch('/add-to-cart/mug', { method: 'POST', credentials: 'same-origin' });
    scope.post('/add-to-cart/:item', async function(req, res) {
        const item = req.params.item;
        if (!req.session.cart) {
            req.session.cart = {};
        }
        // Increment item quantity by 1, defaulting initial state to 0:
        req.session.cart[item] = (req.session.cart[item] || 0) + 1;
        return {
            shoppingCart: req.session.cart
        };
    });

    // A handler for inspecting the cart contents that does not modify the session object.
    // Simply point the browser at http://localhost:3000/cart
    scope.get('/cart', async function(req, res) {
        return {
            shoppingCart: req.session.cart
        };
    });
});


// A handler that tries to behave like /cart but fails because there is no session middleware:
app.get('/no-sessions', async function(req, res) {
    return {
        shoppingCart: req.session.cart
    };
});

app.listen(HTTP_PORT);
