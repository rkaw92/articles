# Sessions: it's race conditions all the way down

## Intro to sessions
* Working definition
* Use cases
    * Shopping cart
    * View state (stage, filters and options)
    * CSRF tokens
* Logical view vs. physical form of sessions

## Example issues
* New session state not saved at all:
    * https://stackoverflow.com/questions/5883821/node-js-express-session-problem
* Race condition that overwrites state:
    * (TODO: Add an own example that is runnable and easy to understand)
    * https://stackoverflow.com/questions/66852129/session-variables-are-undefined-after-refreshing-the-page-in-node-js

## Naive solutions
* Saving session explicitly for long-running handlers
    * Still has a race condition, but the window is shorter
* Locking to avoid concurrent requests per session
    * Low performance
    * A note that PHP does this when using the default session storage
    * Examples that show how to selectively enable sessions for some routes only
    * A note on fastify.js and how its plugin/scope system enables this

## Problem analysis
* Session granularity is wrong for most use cases
* Automatic session saving comes with a lot of pitfalls
* Sessions work as long as you don't use them too much
* "This is the consequence of having such a simple session API" - yonran @ StackOverflow - https://stackoverflow.com/a/5885665/6098312

## Developed solutions
* More granular operations that work with complex data structures
    * Set, map of incrementable counters
    * Await-able API to move exception handling into handler-space (this is important for CSRF if you have a consume-or-fail API)
    * This can lead to domain logic leaking out into infrastructural constructs
    * Expiry is harder
    * This can be a good solution if you just need CSRF tokens and nothing else in the session
    * This is a bad idea for rich stateful applications because it usually precludes idempotence from the start
* Domain state associated with session
    * Session object only stores authorization and associations
    * Separate domain objects
    * Expiry should be considered separately from sessions: e.g. having a separate shopping cart enables "cart recovery" much later.
    * Separate technical facilities such as CSRF token handling
* Authorization-only immutable sessions with no flexible associations
    * State is offloaded to localStorage or sessionStorage, or to other storage mechanisms in case of clients other than the browser
    * CSRF tokens server-side can be mapped 1:1 from session ID to a token container ID in a deterministic way
    * Double-submit cookies can be used instead of stateful tokens
    * JWTs can be used to implement immutable sessions, but some state may still be required for logout/invalidation

## Example implementations
* Separate shopping cart API + association in session
* Separate shopping cart API + immutable session via JWT + client-side association
