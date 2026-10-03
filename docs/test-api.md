# Test Control API

These are endpoints specific to Fauxcord.
Use them to set up your test environment, inspect data, and reset state.

> **No authentication required** — these endpoints can be called without an Authorization header.

---

## `POST /_test/setup` — Create an environment

Registers a Bot, Guilds, and Channels in one call.  
Intended to be called from your test suite's `beforeAll` or `before_each`.

```bash
curl -X POST http://localhost:3000/_test/setup \
  -H "Content-Type: application/json" \
  -d '{
    "token": "Bot mytoken",
    "user": {
      "id": "111111111111111111",
      "username": "MyTestBot"
    },
    "guilds": [
      {
        "id": "222222222222222222",
        "name": "Test Guild",
        "channels": [
          { "id": "333333333333333333", "name": "general", "type": 0 }
        ]
      }
    ]
  }'
```

**Fields**

| Field                      | Required | Description                                           |
| -------------------------- | -------- | ----------------------------------------------------- |
| `token`                    | ✅       | Bot token (including the `"Bot "` prefix)             |
| `user.id`                  | —        | User ID (a Snowflake is auto-generated if omitted)    |
| `user.global_name`         | —        | Global display name (string or null; default: null)   |
| `user.username`            | —        | Username (default: `"MockBot"`)                       |
| `guilds`                   | —        | Array of Guilds to create                             |
| `guilds[].id`              | —        | Guild ID (auto-generated if omitted)                  |
| `guilds[].name`            | ✅       | Guild name                                            |
| `guilds[].owner_id`        | —        | Registered non-bot user ID; defaults to the setup bot |
| `guilds[].channels`        | —        | Array of channels to create                           |
| `guilds[].channels[].id`   | —        | Channel ID (auto-generated if omitted)                |
| `guilds[].channels[].name` | ✅       | Channel name                                          |
| `guilds[].channels[].type` | —        | Channel type (`0`: text, default: `0`)                |

**Response**: The setup result (including any auto-generated IDs)

**Note**: Calling this twice with the same token returns `409 Conflict`.  
For subsequent calls, delete the existing data first via `/_test/reset` or `DELETE /_test/setup/:token`.

To create a guild owned by a human, first register that user through
`POST /_test/users`, then pass its returned ID as `guilds[].owner_id`:

```json
{
  "token": "Bot human-owner-test",
  "guilds": [
    {
      "name": "Human Owned Guild",
      "owner_id": "555555555555555555"
    }
  ]
}
```

Setup adds both the human owner and the bot as guild members. The registered
human profile stays unchanged, including `bot: false`. Guild REST responses
and Gateway `GUILD_CREATE` expose the human's `owner_id`; member REST and
Gateway members expose that same user's identity. Other guilds can select
different human owners or omit `owner_id` to retain the default bot owner.

An explicit `owner_id` must be a non-empty string without surrounding
whitespace. Invalid values (including null), bot users, and reuse of an owner's
ID as the setup bot's `user.id` return `400`. An unregistered owner returns
`404` with Discord code `10013` (Unknown User). A later setup also cannot reuse
an existing human guild owner's ID for its bot account. Failed setup leaves no
partial fixture state or Gateway events.

Deleting a setup still follows its bot token, even when a human owns its guilds.
It deletes those guilds and memberships while retaining registered human users
and other setups, including guilds that share the same human owner.

`SEED_FILE` uses the same `guilds[].owner_id` reference and validation. Referenced
human users must already exist in the database before startup seeding; the
current seed file format registers only bots.

---

## `DELETE /_test/setup/:token` — Completely delete an environment

Deletes the Bot and all of its related data (Guilds, Channels, Messages, Webhooks).
Guild-scoped REST fault controls and their consumption history are also removed.

```bash
curl -X DELETE "http://localhost:3000/_test/setup/Bot%20mytoken"
```

> If the token contains a space, like `Bot mytoken`, encode it as `%20`.

---

## `POST /_test/reset` — Reset posted data and REST faults

Deletes only posted data, while keeping Guild, Channel, and Bot registrations intact.  
Use this for initialization before and after each test case.

### Reset all data

```bash
curl -X POST http://localhost:3000/_test/reset \
  -H "Content-Type: application/json" \
  -d '{}'
```

What gets deleted: messages, webhooks, invites, reactions, pins, embeds, attachments,
and all REST fault controls (including exhausted controls and consumption history).

### Reset only a specific Bot's data

```bash
curl -X POST http://localhost:3000/_test/reset \
  -H "Content-Type: application/json" \
  -d '{"token": "Bot mytoken"}'
```

Only messages sent by that Bot and Webhooks/Invites belonging to that Bot's Guilds are deleted.
REST fault controls in that Bot's Guilds are also deleted, including controls targeting
human-authored messages. Other Bots' Guilds keep their controls.

---

## `POST /_test/rest-faults` — Fail bounded, exact REST attempts

Arm a failure **before** sending the event that triggers the bot's request:

```bash
curl -X POST http://localhost:3000/_test/rest-faults \
  -H "Content-Type: application/json" \
  -d '{
    "method": "DELETE",
    "path": "/channels/333333333333333333/messages/1513052391153471489",
    "status": 403,
    "code": 50013,
    "message": "Missing Permissions",
    "times": 1
  }'
```

Returns `201` with `id`, the supplied configuration, `guild_id`, `channel_id`
(`null` for Guild routes), `remaining`, and `consumed`. Initially `remaining`
equals `times` and `consumed` is zero.

Supported selectors (replace **every** ID with a concrete numeric string):

| Method   | Path                                                | Use                         |
| -------- | --------------------------------------------------- | --------------------------- |
| `DELETE` | `/channels/{channelId}/messages/{messageId}`        | Triggering-message deletion |
| `PUT`    | `/guilds/{guildId}/bans/{userId}`                   | Ban creation                |
| `PATCH`  | `/guilds/{guildId}/members/{userId}`                | Member update / mute        |
| `PUT`    | `/guilds/{guildId}/members/{userId}/roles/{roleId}` | Mute-role assignment        |

`path` must be a bare path with no query, version prefix, wildcard, or trailing
slash. It selects the exact Channel/Message or Guild/User/Role IDs, so unrelated
requests cannot consume the fault. The Channel must belong to an existing Guild,
or the Guild must exist (`404` otherwise). The target Message/User/Role does not
need to exist yet, allowing prearming before message injection. Faults apply to
any authenticated caller issuing that exact request, regardless of token or body.

`status` is an integer from `400` through `599`; `code` is a nonnegative safe
integer; `message` is a nonempty string of at most 1000 characters. `times` is an
integer from `1` through `100`, defaulting to `1`. Invalid/malformed input returns
`400`. An already active fault for the same method/path returns `409`.

On a matching authenticated request, Fauxcord atomically decrements `remaining`
and increments `consumed`, then returns the chosen status with exactly
`{"message":"...","code":...}`. The ordinary route does not run: no message
deletion, ban/purge, member update, role assignment, or corresponding Gateway
mutation event happens. Authentication runs first (`401` attempts do not count);
the normal latency and rate-limit headers still apply. After exhaustion, requests
use the ordinary REST behavior, including ordinary validation and 404 responses.
Automatic library retries count as separate attempts. The control provides the
two-field Discord error body; specialized rate-limit retry fields are not modeled.

All three request prefixes (`/api/v10`, `/api`, and bare) match the same control.
Request query parameters are ignored. Controls and counters are isolated per
database. `/_test/reset` clears them, and environment/Guild deletion cascades
them; Channel deletion also removes message-delete controls for that Channel.
Exhausted records remain inspectable until cleared, and a fresh control may then
be armed for the same selector.

## `GET /_test/rest-faults/:id` — Inspect consumption

Returns the control object, including `remaining` and `consumed`, or `404` for
an unknown/cleared control. Assert `consumed === 1` and `remaining === 0` to prove
a one-shot fault was exercised. Inspection does not consume a fault.

## `DELETE /_test/rest-faults/:id` — Cancel and remove a control

Returns `204` when removed, or `404` if unknown. Removes both the active failure
and its history; subsequent requests run normally.

---

## `GET /_test/messages/:channelId` — Inspect a channel's messages

An endpoint for verifying within your tests that messages have actually arrived.

```bash
curl http://localhost:3000/_test/messages/333333333333333333
```

```json
{
  "messages": [
    {
      "id": "1513052391153471489",
      "content": "Hello, Fauxcord!",
      "author_token": "Bot mytoken",
      "created_at": "2026-06-07 10:00:00"
    }
  ]
}
```

If `author_token` is `"webhook"`, the message was posted via a Webhook.
If `author_token` is an empty string, the message was injected via
`POST /_test/channels/:channelId/messages` (see below) as a non-bot user.

---

## `GET /_test/webhooks/:channelId` — List a channel's Webhooks

```bash
curl http://localhost:3000/_test/webhooks/333333333333333333
```

```json
{
  "webhooks": [
    {
      "id": "1513052391153471490",
      "name": "My Webhook",
      "token": "abcdef1234567890"
    }
  ]
}
```

---

## `POST /_test/users` — Register a non-bot user

Registers a plain (non-bot) user, for joining a Guild or use as the `author`
of an injected message (see below). Unlike `/_test/setup`, an explicit `id`
collision is a hard error — this endpoint never silently reuses an existing row.

```bash
curl -X POST http://localhost:3000/_test/users \
  -H "Content-Type: application/json" \
  -d '{"username": "TestHuman"}'
```

```json
{
  "id": "555555555555555555",
  "username": "TestHuman",
  "discriminator": "0"
}
```

**Fields**

| Field           | Required | Description                                                                                                   |
| --------------- | -------- | ------------------------------------------------------------------------------------------------------------- |
| `id`            | —        | User ID. A Snowflake is auto-generated if omitted. Returns `409 Conflict` if an explicit `id` already exists. |
| `global_name`   | —        | Optional global display name (string or null). Omitted/null values serialize as null in Discord user objects. |
| `username`      | ✅       | Username.                                                                                                     |
| `discriminator` | —        | Defaults to `"0"`.                                                                                            |

The stored `global_name` appears in Discord user/member REST responses and
Gateway payloads, including the initial `GUILD_CREATE` member list and later
`GUILD_MEMBER_UPDATE` events from nickname PATCH requests. For example,
`{"username":"TestHuman","global_name":"Display Name"}` creates a user whose
global display name remains available when their guild nickname is cleared.
`POST /_test/setup` and `SEED_FILE` bot fixtures accept the same nullable field
as `user.global_name`.

---

## `POST /_test/guilds/:guildId/members/:userId` — Join a non-bot user to a Guild

Joins an already registered non-bot user (typically created by `POST /_test/users`)
to an existing Guild. No Authorization header is required. This operation preserves
the user's profile, including `bot: false`, and does not modify the Guild's name,
owner, Bot registrations, Channels, or Roles.

```bash
curl -X POST http://localhost:3000/_test/guilds/222222222222222222/members/555555555555555555 \
  -H "Content-Type: application/json" \
  -d '{"nick": "Test nickname"}'
```

**Fields**

| Field              | Required | Description                                                                                                              |
| ------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------ |
| `guildId` (path)   | ✅       | Existing Guild ID.                                                                                                       |
| `userId` (path)    | ✅       | Existing non-bot user ID. No profile is created or overwritten.                                                          |
| `nick` (JSON body) | —        | Guild nickname, at most 32 characters. Defaults to `null`; explicit `null` is accepted. The body may be omitted or `{}`. |

**Response**: `201 Created` with the actual Guild member object, identical to
`GET /guilds/:guildId/members/:userId`. It contains the stored `user`, `nick`,
server-generated `joined_at` (Discord timestamp with microseconds and `+00:00`),
empty `roles`, `mute: false`, `deaf: false`, and the existing member model's defaults.

The membership transaction commits before exactly one `guild.member.add` is
emitted on Fauxcord's event bus. The existing Gateway sends `GUILD_MEMBER_ADD`
with that member object plus `guild_id` to connected clients with the
`GUILD_MEMBERS` intent (`2`). Membership is immediately readable through REST
when the event arrives. Joining does not emit `GUILD_CREATE`.

**Errors** (no state changes or events):

| Status | Code    | Cause                                                                     |
| ------ | ------- | ------------------------------------------------------------------------- |
| `404`  | `10004` | Unknown Guild.                                                            |
| `404`  | `10013` | Unknown User.                                                             |
| `409`  | `0`     | The user is already a member; their nickname and join time are preserved. |
| `400`  | `0`     | The user is a Bot rather than a non-bot account.                          |
| `400`  | `0`     | Malformed JSON or a body that is not a JSON object.                       |
| `400`  | `50035` | Invalid nickname type or a nickname longer than 32 characters.            |

To test leaving and returning, use the existing authenticated member DELETE:

```bash
curl -X DELETE http://localhost:3000/api/v10/guilds/222222222222222222/members/555555555555555555 \
  -H "Authorization: Bot mytoken"

# Join the same profile again, with a new join time and default null nickname.
curl -X POST http://localhost:3000/_test/guilds/222222222222222222/members/555555555555555555
```

DELETE returns `204`, removes membership and role assignments, and emits
`GUILD_MEMBER_REMOVE` through the existing Gateway path. The user profile remains
registered, so the next test join returns `201` and emits a new `GUILD_MEMBER_ADD`.
This endpoint operates on current state; event replay is not provided.

---

## `POST /_test/channels/:channelId/messages` — Inject a message from a specific user

Creates a message in a channel authored by a pre-registered user (typically
one created via `POST /_test/users`), letting you pick an arbitrary non-bot
author — unlike the bot/webhook message paths (`POST /channels/:id/messages`,
Webhook execution), which always resolve the author to a bot or Webhook
account. If the channel belongs to a Guild, the author is also registered
as a Guild member.

```bash
curl -X POST http://localhost:3000/_test/channels/333333333333333333/messages \
  -H "Content-Type: application/json" \
  -d '{"content": "Hello from a human!", "author": {"id": "555555555555555555"}}'
```

Returns the created message object (same shape as
`POST /channels/:channelId/messages`), with `author.bot: false`.

**Fields**

| Field                 | Required | Description                                                                                                                       |
| --------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `content`             | ✅       | Message content.                                                                                                                  |
| `author.id`           | ✅       | ID of a user already registered via `POST /_test/users` (or any other existing user). Returns `404` if unregistered.              |
| `id`                  | —        | Explicit numeric Message ID (1–20 digits), otherwise generated. An existing Message ID returns `409` without mutations or events. |
| `remove_after_create` | —        | Boolean, default `false`. Remove the message immediately after its native create dispatch is queued.                              |

To test a triggering-message DELETE failure, choose a unique `id`, arm its exact
DELETE path through `/_test/rest-faults`, then inject with that same `id`. The bot
receives the ordinary native `MESSAGE_CREATE` and its real REST DELETE consumes
the fault. For example, use `403` / `50013` / `Missing Permissions` to exercise an
error other than Unknown Message while retaining the message.

To test **real Unknown Message** without a race or fixed sleep, inject with
`"remove_after_create": true` and do not arm a DELETE fault. The service first
creates the real stored message and synchronously emits its ordinary create
event. It then uses ordinary deletion before yielding to another HTTP request,
emitting `MESSAGE_DELETE`. Connected clients with the Guild Messages intent see
`MESSAGE_CREATE` followed by `MESSAGE_DELETE` in order; the create payload still
contains the original content and author. Any REST DELETE issued in response to
the create event finds the actual message absent and returns the ordinary `404`
/ `10008` / `Unknown Message`; GET and `/_test/messages` also show it absent.
The injection still returns `201` with the created message snapshot, even though
that message has already been deleted. Dispatch is queued synchronously, not
acknowledged by clients: connect and wait for Gateway READY before injecting.
This option applies only to this injection and leaves no pending control behind.

---

## `PATCH /_test/channels/:channelId/messages/:messageId` — Edit a human message

Replaces the content of an existing message authored by a registered non-bot
user, including messages created with the injection route above. Like other
`/_test/*` routes, this control endpoint requires no authentication. Use the
channel and message IDs returned by injection; no author ID or human token is
needed. Normal Discord REST message edits still enforce bot authorship.

```bash
# After registering the human and injecting a retained message, use its ID:
curl -X PATCH http://localhost:3000/_test/channels/333333333333333333/messages/MESSAGE_ID \
  -H "Content-Type: application/json" \
  -d '{"content": "Updated human message"}'
```

The JSON object must contain a string `content` of at most 2,000 characters
(the same length validation as ordinary message edits). Empty strings, Unicode,
and unchanged content are accepted. Other fields are ignored. Only content and
the edit timestamp change: message ID, channel, author (`bot: false`), original
timestamp, embeds, attachments, reactions, flags, and other fields are preserved.

Returns `200` with the actual persisted message object. The ordinary message
service emits native `MESSAGE_UPDATE` with the edited message, guild ID and
member information for guild channels. Connect the application bot and wait for
Gateway READY before injecting or editing, using the Guild Messages intent.
The same bot connection and identity remain active; unchanged content also
updates the edit timestamp and emits an update, as with ordinary REST edits.
Dispatch is queued without waiting for a client acknowledgement.

Errors leave the message unchanged and emit no update:

| Status / code   | Meaning                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `400` / `50035` | Missing or invalid JSON object, missing/non-string `content`, or content over the existing message limit. Includes `errors.content`. |
| `404` / `10003` | Unknown channel.                                                                                                                     |
| `404` / `10008` | Missing/deleted message, missing author profile, or message belongs to another channel.                                              |
| `400` / `0`     | Message author is a bot or webhook, rather than a registered human.                                                                  |

This control operates synchronously on the current fixture data and installs no
pending control. A message injected with `remove_after_create: true` is already
deleted and cannot be edited. Test setup deletion/reset continues to govern
message lifetime.

---

## `POST /_test/interactions` — Simulate an interaction

Generates a pseudo-interaction against a registered command (global or
guild-scoped) and dispatches it to the bot via the Gateway as
`INTERACTION_CREATE`. Responds `201` immediately with the interaction's
info; the Gateway dispatch happens asynchronously right after.

```bash
curl -X POST http://localhost:3000/_test/interactions \
  -H "Content-Type: application/json" \
  -d '{
    "application_id": "111111111111111111",
    "command_name": "ping",
    "guild_id": "222222222222222222",
    "channel_id": "333333333333333333"
  }'
```

**Fields**

| Field            | Required | Description                                                                                                 |
| ---------------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `application_id` | ✅       | The bot's application ID (same as its `user.id`)                                                            |
| `command_name`   | ✅       | Name of a command already registered via the Application Commands API                                       |
| `type`           | —        | Interaction type (default: `2`, APPLICATION_COMMAND)                                                        |
| `guild_id`       | —        | Guild ID. When set, prefers a guild-scoped command match, falling back to a global command of the same name |
| `channel_id`     | —        | Channel ID the interaction is bound to (needed for `type: 4`/`5` original responses and followups)          |
| `user_id`        | —        | Invoking user ID (auto-generated if omitted)                                                                |
| `options`        | —        | Command option values, passed through into the interaction's `data.options`                                 |

**Response**: `201` with the created interaction object (matches the
Discord `Interaction` shape). `404` (`{"message": "404: Not Found", "code": 0}`)
when `command_name` does not match any registered command in scope.

The optional `locale` field accepts the invoking user's
[Discord locale](https://docs.discord.com/developers/reference#locales), such
as `pl` or `en-GB`, and defaults to `en-US`. The response and Gateway event
include the same top-level `locale` on every interaction type except PING
(`type: 1`). The user locale is independent of the guild's preferred locale.
An unsupported, empty, or non-string locale returns `400` with code `50035`
and a `locale` field error; no interaction is created or dispatched.

Bots can acknowledge the Gateway interaction with a type-5 callback
(`DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE`) and later complete it through
`PATCH /webhooks/{application_id}/{interaction_token}/messages/@original`.
The callback returns `204`, or `200` with `with_response=true`; that response
includes `response_message_id`, `response_message_loading: true`, and
`response_message_ephemeral`. A second callback returns `400`, code `40060`
(Interaction has already been acknowledged), so clients can fall back to
editing the original response.

`GET .../messages/@original` returns the pending message with the `LOADING`
flag (`128`). Consumers waiting for completed output must check
`(message.flags & 128) === 0` before using its content or embeds. Editing
completes that same message and clears `LOADING`, preserving its ID, channel,
bot author, application/webhook IDs, and original `interaction` metadata.
Public responses can also be observed through channel message REST endpoints
and Gateway `MESSAGE_CREATE`/`MESSAGE_UPDATE` events. Type-4 direct responses
remain supported through the same original-response endpoints.

Type-5 callbacks accept only the `EPHEMERAL` flag (`64`, or `0` for public).
Ephemeral responses retain that visibility when edited, are available through
the interaction token, and are excluded from channel message retrieval and
Gateway message events. Other callback types retain the mock's existing scope;
types 6/7/9 acknowledge without creating an original response. Token expiry,
component rendering, and uploaded response attachments are not modeled here.

---

## `POST /_test/polls/:messageId/votes` — Inject a poll vote

Registers a vote from a pre-registered user (typically one created via
`POST /_test/users`) on an existing poll's answer, for verifying your
bot's poll-vote handling without a real Discord client casting the vote.

```bash
curl -X POST http://localhost:3000/_test/polls/1513052391153471489/votes \
  -H "Content-Type: application/json" \
  -d '{"answer_id": 1, "user_id": "555555555555555555"}'
```

**Fields**

| Field       | Required | Description                                                                           |
| ----------- | -------- | ------------------------------------------------------------------------------------- |
| `answer_id` | ✅       | ID of an existing poll answer (from the message's `poll.answers`).                    |
| `user_id`   | ✅       | ID of a user already registered via `POST /_test/users` (or any other existing user). |

**Response**: `204 No Content` on success. `404` (`{"message": "404: Not Found", "code": 0}`) when the message has no poll, or the answer ID does not exist on it. `400` (`{"message": "400: Bad Request", "code": 0}`) when `answer_id` or `user_id` is missing.

---

## `GET /_mock/health` — Check server status

```bash
curl http://localhost:3000/_mock/health
```

```json
{
  "status": "ok",
  "version": "1.0.0",
  "db": "ok",
  "uptime": 42
}
```

If `db` is not `"ok"`, there is a problem with SQLite.

---

## `GET /_mock/attachments/:channelId/:messageId/:filename` — Download an attachment

Message and application attachment responses contain a public `url` and `proxy_url` under this path. Fetch the returned URL without an Authorization header to verify the uploaded bytes in your test.

```bash
curl http://localhost:3000/_mock/attachments/333333333333333333/1513052391153471489/proof.txt
```

The response uses the uploaded file's content type and returns the original bytes. An attachment that does not exist returns `404` with Fauxcord's standard error response.

---

## Typical test flow

```
1. At the start of the test suite
   POST /_test/setup   → Register Bot / Guild / Channel

2. Before each test case
   POST /_test/reset   → Clear messages etc.

3. Run the test
   Call the API via a Discord library

4. Assertions
   Verify message delivery via GET /_test/messages/:channelId

5. At the end of the test suite (optional)
   DELETE /_test/setup/:token  → Complete deletion
```

### Example: usage with vitest

```typescript
import { beforeAll, beforeEach, describe, it, expect } from 'vitest'

const BASE = 'http://localhost:3000'
const TOKEN = 'Bot test-token'
const CHANNEL_ID = '333333333333333333'

beforeAll(async () => {
  await fetch(`${BASE}/_test/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: TOKEN,
      user: { id: '111111111111111111', username: 'TestBot' },
      guilds: [
        {
          id: '222222222222222222',
          name: 'Test Guild',
          channels: [{ id: CHANNEL_ID, name: 'general', type: 0 }],
        },
      ],
    }),
  })
})

beforeEach(async () => {
  await fetch(`${BASE}/_test/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
})

it('sends a message', async () => {
  // Send a message via the library
  await sendMessage(CHANNEL_ID, 'hello')

  // Verify delivery via /_test/messages
  const res = await fetch(`${BASE}/_test/messages/${CHANNEL_ID}`)
  const { messages } = await res.json()
  expect(messages.some((m) => m.content === 'hello')).toBe(true)
})
```
