# Sessions: it's race conditions all the way down
# Alt title: Sessions - too good to be true

## Real-world usage

Sessions are a ubiquitous tool - they are usually taught early on as *the solution* for keeping state associated with a client. Their contents are controlled entirely by the server, which makes them the perfect place to put authorization information in. Indeed, most browser-facing Web applications rely on stored session state to determine the user's ID, their permission level, and sometimes to provide cached information about their user profile, given how it's ready at hand. In this sense, the session can be said to be **about the user**.

However, being so versatile with a deceptively simple API, sessions also end up utilized in a variety of other scenarios: as grab-bags of view-related properties, as the backing storage for shopping cart contents, and finally, as technical realizations of security measures such as [CSRF tokens](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html#token-based-mitigation).

In this article, we are going to take a careful look at the perils that await the unsuspecting programmer, as stemming from session usage, particularly in the aforementioned use cases. Practical problems and solutions are presented based on popular Node.js Web frameworks (express, fastify), with passing references to PHP (which, thanks to its built-in session mechanism, serves as a good model for making comparisons with). It is my hope that the examples are clear enough to be understood by developers working in other languages and with other libraries.

## Two views of sessions

In order to comprehensively present the problems related to session usage, we need to consider the session mechanism from two angles:
* Logical view - the API exposed to the programmer
* Physical view - the database and cookies that implement the storage and transfer of session data and ID

Our primary interest is how the disconnect between the apparent simplicity of the former and the intrinsic complexity of the latter can lead to issues, and what can be done about it. Without further ado, let's jump straight to code.

### Logical view - the session API

Consider an example HTTP request handler implementation in Node.js with `express-session` ([full code available here](code/express-session-simple.js)):
```js
app.post('/add-to-cart/:item', function(req, res) {
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
```

From the developer's point of view, interacting with the session is as simple as setting properties on an object (JavaScript objects have a dynamic set of keys, so they are often used in lieu of dedicated data structures such as `Map`). As seen above, basic logic can be implemented in the most straightforward way imaginable.

Practicioners of object-oriented modelling disciplines such as Domain-Driven Design will identify the above piece of code as exhibiting an [anemic domain model](https://www.martinfowler.com/bliki/AnemicDomainModel.html), where business logic is commonly placed in a "controller" rather than in methods of an object that encapsulates the data. On the other hand, it is definitely possible to [instantiate behavior-rich objects based on session state](https://github.com/auchenberg/nodejs-shopping-cart/blob/f59cb09679bd5c5ab9a05849223de56fd3bd9ee3/routes/index.js#L23), so this is not a defining feature of all session-based code - just an incidental property.

#### Defining the session programming model

If we were to distill this session programming model into a sentence, it could sound like this:
> Sessions allow the programmer to retrieve a complete state object associated with the session ID and optionally overwrite it with a new, modified version.

It provides a feature known as [atomicity](https://en.wikipedia.org/wiki/ACID#Atomicity) - the session state is written in its entirety, so the changes introduced by a handler do not need to be guarded by a database transaction (or generally a [Unit of Work](https://martinfowler.com/eaaCatalog/unitOfWork.html)) to avoid partial writes. Since the whole object gets replaced, we get another property for free: [consistency](https://en.wikipedia.org/wiki/ACID#Consistency) of properties within a single session, since all properties are overwritten on save. Let's call this *session granularity*. Later, we will see if this behavior can (or should) be relaxed (by using a different *granularity*) and how it impacts the mentioned features.

If your application uses a persistent session store ([which is not the default for express-session](https://github.com/expressjs/session/tree/v1.17.1#sessionoptions)), session state is also [durable](https://en.wikipedia.org/wiki/Durability_(database_systems)) - it persists not just across requests, but also across restarts of the application process. In other words, the *thing that session ID points at* in the database continues to exist over time, though in case of sessions we do expect it to expire at some point in the future.

Overall, these are pretty strong guarantees and they seem useful, even if they span only a single object for a single logical user. We are one letter short of ACID, the Holy Grail of correctness in data-driven applications. We have not mentioned the "I" ([isolation](https://en.wikipedia.org/wiki/ACID#Isolation)), and for good reason: it has, so far, been invisible to us. In order to be able to talk about isolation and concurrency, we'll need to take a look at the physical model - the infrastructure that allows us to work with session data using the simple API described above.

### Physical view - the persistence layer

Let us construct a conceptual model of how the session infrastructure operates, similarly to how we did with the user-facing API. A session middleware needs to perform these steps at minimum:
* [Find out the current session ID from cookies](https://github.com/expressjs/session/blob/v1.17.1/index.js#L217) (or generate a new one)
* [Load current session state from storage](https://github.com/expressjs/session/blob/v1.17.1/index.js#L481) based on session ID
* [Pass the loaded object to the request handler](https://github.com/expressjs/session/blob/v1.17.1/session/store.js#L100) for reading and possibly mutating
* [Wait until the request handler finishes execution](https://github.com/expressjs/session/blob/v1.17.1/index.js#L246) (this seems obvious, but [can be a source of bugs](https://stackoverflow.com/questions/66852129/session-variables-are-undefined-after-refreshing-the-page-in-node-js/66852239#66852239))
* [Check if session state was modified](https://github.com/expressjs/session/blob/v1.17.1/index.js#L420)
* [Write the new session state](https://github.com/expressjs/session/blob/v1.17.1/index.js#L331) if modified

(Links above lead to implementation details in the most recent version of [express-session](https://www.npmjs.com/package/express-session) at the time of writing - `v1.17.1`.)

Developers familiar with SQL (or database work in general) will notice that this is a [read-modify-write](https://www.2ndquadrant.com/en/blog/postgresql-anti-patterns-read-modify-write-cycles/) cycle, which is naturally prone to race conditions: if two concurrent handler executions read the same state, each applies their update, and then both write the state back to the store, *atomicity and consistency* together guarantee that only one of these two versions will remain. From the user's point of view, both updates are successful, but the changes from one of them are overwritten by the other - the last writer wins. Thanks for nothing, AC!

#### Isolation and concurrency

In terms of ACID, we can say that session semantics exhibit some level of isolation - in that each handler gets its own copy of the session data to work with, and in-memory modifications of the object do not "leak" into other handlers. Changes to session state are visible only after one handler saves the session and another loads it. At the same time, we are missing concurrency control - a key piece that would allow us to avoid *lost updates*.

**Concurrency** is the complexity that the session facade hides, and also the source of most session-related problems. It is hardly a new topic in programming - the [1981 Jim Gray paper](http://jimgray.azurewebsites.net/papers/thetransactionconcept.pdf), which describes what a database transaction should look like, does so largely in terms of practicality under conditions of concurrency.

Going further, we are going to explore two general approaches to handling concurrency (as applicable to sessions) that preserve consistency, as well as take a look at other solutions which make different trade-offs. But first, let us try and reproduce some concurrency issues ourselves, if only to see what we're up against.

## Session-related issues: an example

### Triggering a race condition
In order to make triggering race conditions simpler, we're going to modify our previous script so that a POST request handler takes much longer to finish. This is going to increase the time window in which the *second* handler invocation can read the session state, before both concurrent invocations write their new state back, one replacing the other. In production-grade code, we [obviously](https://thedailywtf.com/articles/The-Slow-Down-Loop) would not have an explicit delay, making the issue harder to observe. This makes it even more important to be aware of the possibility, to save ourselves from having to chase down a phantom bug.

We add a deliberate wait ([see the full source code for a runnable version](./code/express-session-simple-delay.js)):
```js
function delay(durationMS) {
    return new Promise(function(resolve) {
        setTimeout(resolve, durationMS);
    });
}

// ...

app.post('/add-to-cart/:item', async function(req, res) {
    const item = req.params.item;
    if (!req.session.cart) {
        req.session.cart = {};
    }
    // Simulate doing some time-consuming work - fetching prices, reserving wares in stock, etc.
    await delay(HANDLER_DELAY_MS);
    // Increment item quantity by 1, defaulting initial state to 0:
    req.session.cart[item] = (req.session.cart[item] || 0) + 1;
    res.json({
        shoppingCart: req.session.cart
    });
});
```

Now, if we issue two concurrent POST requests within our time window like this, in the browser's DevTools JavaScript console:
```js
fetch('/add-to-cart/mug', { method: 'POST', credentials: 'same-origin' });
fetch('/add-to-cart/mug', { method: 'POST', credentials: 'same-origin' });
```

Quite unsurprisingly, both responses only report a quantity of 1 in the cart:
```json
{"shoppingCart":{"mug":1}}
```

The full source code includes another path, `/cart`, which can be viewed from the browser to inspect the final state of the cart, after both requests have finished.

Similarly, if the requests were for different items, only one of them would end up in the cart, which is never what the user wants:
```js
fetch('/add-to-cart/phone', { method: 'POST', credentials: 'same-origin' });
fetch('/add-to-cart/charger', { method: 'POST', credentials: 'same-origin' });
```

Now, a look at `/cart` will most likely show:
```json
{"shoppingCart":{"charger":1}}
```

In reality, it could be one or the other - the operations that a real handler implementation performs could take a variable duration of time, so there's no telling which of the two handlers would finish first in an actual application. What is certain is this: **our application has a bug that impacts the users**.

### Security-related issues
Another common use case for sessions is storing one-time tokens that prevent [Cross-Site Request Forgery](https://owasp.org/www-community/attacks/csrf) (called "CSRF tokens" for short). A typical implementation involves generating a token (an unpredictable string), sending it back to the client, meanwhile storing the same token in session state. Then, when the user wishes to perform an action, their browser needs to send the token it just got, and the server must consult the session state to check if the token is valid. If so, the token gets used up - it is removed from the session. This prevents cross-site POST requests from maliciously acting on the user's behalf.

An observant reader will point out there are two race conditions possible:
1. When adding tokens to the session - for example, if the user, being an online store admin, opens two browser tabs with different product pages as they're about to replace one product that's being phased out with a "new and improved" version. If the pages are opened at the same time, only one token may make it to session storage - the other page will have received a token that is not in the session's set of valid tokens (got overwritten), so a form located on that page may not work because it fails CSRF token validation.
2. When using tokens - it may be possible to sneak in two or more concurrent requests with the same CSRF token, and have all of them succeed. The security impact of this is rather low, as an attacker who is able to pull this off must already be able to interact with the site directly (as in: same-origin). However, it's worth pointing out that programmers may sometimes rely on CSRF tokens as a means of protection against double form submission ("sorry, double post"). Due to race conditions, this will not work - the times when a user may want to press a button again (because the page appears stuck) largely overlap with cases when the window for a race condition is very long (the back-end is taking long to process the request).

Due to these issues, we are going to discuss the preferred method of dealing with CSRF tokens in a later section.

### Examples in the wild
Concurrency bugs related to sessions are not just a theoretical issue that's only reproducible in a lab setting. Here are some problems that users typically encounter, along with attempted solutions:
* https://stackoverflow.com/questions/5883821/node-js-express-session-problem
* https://stackoverflow.com/questions/28602214/node-express-concurrency-issues-when-using-session-to-store-state

All of the troublesome examples above refer to a particular stack - Node.js + express. At the same time, sessions are not a novel concept and we'd expect existing libraries and frameworks to have solved the concurrency problem by now.

## Lessons from other languages: PHP
Take PHP, for instance. PHP is a Web development language that owes much of its adoption to the breadth of built-in functionality: everything from input processing to database connectivity is provided out-of-the-box. How does this once-popular language handle session state?

The [default session save handler](https://www.php.net/manual/en/session.configuration.php#ini.session.save-handler) in PHP is `files`. This means that a directory in the server's filesystem is used to store session data, one file per session. It is not very practical in a clustered application with many server processes running on different hosts, but this implementation dates back to a simpler time, when the default deployment scenario was a single host, plus perhaps a failover host in an "enterprise" setting (remember [LAMP](https://en.wikipedia.org/wiki/LAMP_(software_bundle))?).

Having the files stored locally confers an advantage: since the operating system controls all filesystem access, it can prevent concurrent read-write cycles by using **locking**. Indeed, PHP's default session storage back-end locks the session file for *exclusive access* throughout the request handling process. As a consequence, [only one request can be processed at a time with a given session ID](https://ma.ttias.be/php-session-locking-prevent-sessions-blocking-in-requests/), which reduces performance - to the point that some developers decide they must circumvent the locking, possibly sacrificing correctness.

When using locks of any kind, it is imperative that the lock be kept for only as long as necessary. Specifically, session locks are supposed to guard the session data against corruption. Therefore, the simplest way to increase performance is to [release the lock](https://www.php.net/manual/en/function.session-write-close.php) as soon as session manipulation is finished:
```php
<?php
// Lock the session and populate superglobal variable $_SESSION:
// (This may not be necessary, depending on the option `session.auto_start` in php.ini)
session_start();
// Use session variables - append the currently-viewed product's ID to "last viewed":
array_unshift($_SESSION["last_viewed_products"], $_GET["product_id"]);
// We're done with the session: write and release the lock.
session_write_close();
// Render the product page, issuing additional queries and doing other time-consuming
//  tasks, which now do not extend the lock duration:
ProductView::render();
```

Note that PHP does not distinguish between read-only (shared) locks and read-write locks for sessions - every lock is exclusive. It is possible, however, to request an immediate session lock release to increase performance in case we're only interested in reading the session state, not writing it (supported since PHP 7). This is useful e.g. for authorization:
```php
<?php
session_start([
    'read_and_close'  => true,
]);
if (!$_SESSION['isAdmin']) {
    http_response_code(403);
    throw new Exception('This page requires special permissions to access');
}
```

### Side note: Differences between implementations
Nowadays, PHP supports many different implementations of session storage. Each individual module may or may not implement locking. For example:
* [The memcached extension supports session locking](https://www.php.net/manual/en/memcached.configuration.php#ini.memcached.sess-locking), and defaults it to enabled (`memcached.sess_locking = On`)
* [phpredis supports session locking](https://github.com/phpredis/phpredis#session-locking) in a leader-follower topology, but it defaults to disabled and has to be enabled by `redis.session.locking_enabled = 1`

There doesn't seem to be a well-established SQL-based session handler for PHP, so most CMSes and blog platforms (Drupal, WordPress) rely on own modules and plug-ins with various features and assumptions.

### Excluding routes from session logic
Since lock acquisition and data loading only happens in PHP after `session_start()`, we can be selective about what files ("routes") should invoke session logic. Specifically, publicly-accessible routes will usually not need to refer to any session state, and can skip the locking altogether. This is doubly important in case assets are served via PHP to an asynchronous single-page app - for example, dynamically-generated images, or data that is resolved and fetched in parallel, like user profiles, movie metadata or product recommendations.

There's a lesson here: whether our application is suffering from poor performance due to locking, or from lost updates due to race conditions with no locking, minimizing the set of routes that receive the session data should help. We've seen how to achieve this in PHP. Various Web frameworks for Node.js also enable the developer to specify which routes should trigger the session *middleware* and which shouldn't.

Here is a modernized `express-session` example based on an old [StackOverflow answer](https://stackoverflow.com/questions/15877342/nodejs-express-apply-session-middleware-to-some-routes) that demonstrates how to run sessions for one route only:
```js
const sessions = require('express-session');
const sessionMiddleware = sessions({
    // pass options here
});

app.get('/your/route/here', sessionMiddleware, function(req, res){
    // code for route handler goes here
});
```

A more recent Web framework, [fastify.js](https://www.fastify.io/), allows us to install a session middleware within a *scope* thanks to its *plug-in system*. This isolates the effects of the middleware to the routes in the same scope ([see full example](./code/fastify-session-two-routes-only.js)):
```js
app.register(async function(scope) {
    scope.register(sessions, {
        secret: SESSION_SECRET,
        cookie: {
            // Note: this is for development only because we run on plain-text HTTP.
            secure: false
        }
    });
    scope.post('/add-to-cart/:item', async function(req, res) {
        // handler code here
    });
    scope.get('/cart', async function(req, res) {
       // another handler that uses session data
    });
});

app.get('/no-sessions', async function(req, res) {
    // handler that has no req.session and doesn't load session data
});
```
