const express = require('express');
const HTTP_PORT = process.env.HTTP_PORT || 3000;

const app = express();

app.get('/', function(req, res) {
    console.log('called /');
    res.header('Location', '/target');
    res.writeHead(307);
    setTimeout(function() {
        res.end('This is the body of the first page, which should immediately redirect to the target page');
        console.log('/: res.end()');
    }, 5000);
});

app.get('/target', function(req, res) {
    console.log('called /target');
    res.send('This is the target page for the redirect to go to');
    console.log('/target: res.send()');
});

app.listen(HTTP_PORT);
