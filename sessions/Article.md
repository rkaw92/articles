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

It provides a feature known as [atomicity](https://en.wikipedia.org/wiki/ACID#Atomicity) - the session state is written in its entirety, so the changes introduced by a handler do not need to be guarded by a database transaction (or generally a [Unit of Work](https://martinfowler.com/eaaCatalog/unitOfWork.html)) to avoid partial writes. Since the whole object gets replaced, we get another property for free: [consistency](https://en.wikipedia.org/wiki/ACID#Consistency) of properties within a single session, since all properties are updated together. Later, we will see if this behavior can (or should) be relaxed and how it impacts the mentioned properties.

If your application uses a persistent session store ([which is not the default for express-session](https://github.com/expressjs/session/tree/v1.17.1#sessionoptions)), session state is also [durable](https://en.wikipedia.org/wiki/Durability_(database_systems)) - it persists not just across requests, but also across restarts of the application process. In other words, the *thing that session ID points at* in the database continues to exist over time, though in case of sessions we do expect it to expire at some point in the future.

Overall, these are pretty strong guarantees and they seem useful, even if they span only a single object for a single logical user. We are one letter short of ACID, the Holy Grail of correctness in data-driven applications. We have not mentioned the "I" ([isolation](https://en.wikipedia.org/wiki/ACID#Isolation)) so far, and for good reason: it has, so far, been invisible to us. In order to be able to talk about isolation and concurrency, we'll need to take a look at the physical model - the infrastructure that allows us to work with session data using the simple API described above.

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

We can say that session semantics exhibit some level of isolation - in that each handler gets its own copy of the session data to work with, and in-memory modifications of the object do not "leak" into other handlers. At the same time, we are missing concurrency control - a crucial component of higher isolation levels, such as [serializable isolation](https://en.wikipedia.org/wiki/Serializability).

**Concurrency** is the complexity that the session facade hides, and also the source of most session-related problems. It is hardly a new topic in programming - the [1981 Jim Gray paper](http://jimgray.azurewebsites.net/papers/thetransactionconcept.pdf), which describes what a database transaction should look like, does so largely in terms of practicality under conditions of concurrency.

## Session-related issues: an example
