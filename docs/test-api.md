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
Guild-scoped audit-log fixtures, REST fault controls, and their consumption history are also removed.

```bash
curl -X DELETE "http://localhost:3000/_test/setup/Bot%20mytoken"
```

> If the token contains a space, like `Bot mytoken`, encode it as `%20`.

---

## `POST /_test/reset` — Reset posted data, audit logs and REST faults

Deletes only posted data, while keeping Guild, Channel, and Bot registrations intact.  
Use this for initialization before and after each test case.

### Reset all data

```bash
curl -X POST http://localhost:3000/_test/reset \
  -H "Content-Type: application/json" \
  -d '{}'
```

What gets deleted: messages, webhooks, invites, reactions, pins, embeds, attachments,
audit-log fixtures, and all REST fault controls (including exhausted controls and consumption history).

### Reset only a specific Bot's data

```bash
curl -X POST http://localhost:3000/_test/reset \
  -H "Content-Type: application/json" \
  -d '{"token": "Bot mytoken"}'
```

Only messages sent by that Bot and Webhooks/Invites belonging to that Bot's Guilds are deleted.
REST fault controls in that Bot's Guilds are also deleted, including controls targeting
human-authored messages. Audit-log fixtures are cleared by the target Guild's Bot token,
regardless of their actor or target author. Other Bots' Guilds keep their controls and audit history.

---

## `POST /_test/guilds/:guildId/audit-logs` — Create a deletion audit fixture

Create an audit entry independently of messages and Gateway events. This operation
neither deletes a message nor emits an event. Register the actor and target author
first with `/_test/setup` or `POST /_test/users`; the channel must belong to the
specified Guild. Users need not still be Guild members.

```bash
curl -X POST http://localhost:3000/_test/guilds/222222222222222222/audit-logs \
  -H "Content-Type: application/json" \
  -d '{
    "action_type": 72,
    "user_id": "111111111111111111",
    "target_id": "555555555555555555",
    "options": { "channel_id": "333333333333333333", "count": "1" }
  }'
```

Returns `201` with the Discord-shaped entry: `id`, `action_type`, `user_id`,
`target_id`, and `options`. Only `MESSAGE_DELETE` (`72`) is supported. `user_id`
is the actor; `target_id` is the deleted message's author. `options.channel_id`
and a positive decimal **string** `options.count` are required. IDs must be
canonical nonzero unsigned 64-bit decimal strings. Counts must fit a safe integer.
Unsupported fields/actions, malformed JSON, and invalid values return `400`;
unknown Guild/User or a channel outside the Guild returns `404`; duplicate entry
IDs across any Guild return `409`. Rejected requests leave the database unchanged.

Omit `id` and `timestamp` to generate a recent entry. For deterministic history,
provide either an explicit unique `id` or `timestamp` in UTC ISO format, such as
`"2026-01-01T00:00:00.000Z"`. The timestamp is encoded in the Snowflake's upper
bits, with the lower 22 bits zero. Reusing a timestamp therefore returns `409`;
use explicit distinct IDs for multiple entries in one millisecond. The timestamp
must be after Discord's epoch and within the Snowflake range. There is no extra
`timestamp` field in the Discord entry: clients derive its age from `id`.

Read entries through authenticated `GET /api/v10/guilds/:guildId/audit-logs`
(also `/api` and bare paths). Existing Guild access checks apply. It returns only
that Guild's entries and deduplicated referenced actor/target users, plus empty
arrays for other referenced entity types. History is empty until fixtures are
created. Message deletion does not automatically create audit entries.

Supported filters are `action_type`, actor `user_id`, `target_id` (also present in
the committed OpenAPI spec), strict `before`/`after` Snowflake cursors, and `limit`
(`1`–`100`, default `50`). Results are newest first by default and with `before`;
`after` returns oldest first, as documented by
[Discord](https://docs.discord.com/developers/resources/audit-log#get-guild-audit-log).
If both cursors are supplied, both bounds apply and the order follows `after`.
The default cursor includes the current millisecond and omits future-dated entries;
explicit cursors can retrieve future fixtures. Invalid query values return `400`.

To test recent attribution, seed a generated entry for the expected author. To
test stale attribution, seed an older `timestamp` or Snowflake. To test a mismatch,
choose another registered `target_id` or another channel in the same Guild. For
empty history, create no fixture or call `/_test/reset`. Fixtures persist until
reset or Guild/setup deletion; there is no automatic 45-day retention purge.
Channel deletion leaves historical audit entries intact. Bot-scoped reset follows
the fixture's Guild, even when its actor is another Bot or a human.

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

To fail an edit-log send, use `"method": "POST"` and
`"path": "/channels/333333333333333333/messages"` with the desired status, code,
message, and count. For example, a representative server failure is
`"status": 500, "code": 0, "message": "Internal Server Error"`.

Returns `201` with `id`, the supplied configuration, `guild_id`, `channel_id`
(`null` for Guild and User routes), `remaining`, and `consumed`. Initially `remaining`
equals `times` and `consumed` is zero.

Supported selectors (replace **every** ID with a concrete numeric string):

| Method   | Path                                                | Use                         |
| -------- | --------------------------------------------------- | --------------------------- |
| `POST`   | `/channels/{channelId}/messages`                    | Message / edit-log sending  |
| `DELETE` | `/channels/{channelId}/messages/{messageId}`        | Triggering-message deletion |
| `PUT`    | `/guilds/{guildId}/bans/{userId}`                   | Ban creation                |
| `PATCH`  | `/guilds/{guildId}/members/{userId}`                | Member update / mute        |
| `PUT`    | `/guilds/{guildId}/members/{userId}/roles/{roleId}` | Mute-role assignment        |
| `GET`    | `/guilds/{guildId}/audit-logs`                      | Deletion audit-log reads    |
| `GET`    | `/guilds/{guildId}/members/{userId}`                | Member reads                |
| `GET`    | `/users/{userId}`                                   | Global user reads           |

`path` must be a bare path with no query, version prefix, wildcard, or trailing
slash. It selects the exact Channel, Channel/Message, or Guild/User/Role IDs, so
unrelated requests cannot consume the fault. The Channel must belong to an existing Guild,
or the Guild must exist (`404` otherwise). The target Message/User/Role does not
need to exist yet, allowing prearming before message injection. Existing
`POST`/`DELETE`/`PUT`/`PATCH` faults apply to any authenticated caller issuing that
exact request, regardless of token or body.

`GET` faults apply only to the registered Bot that owns the scope's Guild
(`guilds.bot_token`). Nonowner Bots and Bearer callers run the ordinary route
without consuming the control. Guild GETs derive their scope from the path; an
optional `guild_id` must equal that path's Guild ID. Global `/users/{userId}` GETs
**require** an explicit numeric `guild_id` of an existing Guild:

```json
{
  "method": "GET",
  "path": "/users/555555555555555555",
  "guild_id": "222222222222222222",
  "status": 404,
  "code": 10013,
  "message": "Unknown User",
  "times": 1
}
```

This Guild selects the owning Bot and ties the control to Guild deletion and
scoped reset, even though the REST user lookup is global. Separate Bots may arm
independent faults for the same User. A global user request carries no Guild ID,
so a fault applies to that Bot's exact User lookup across its Guild scenarios.
Use separate Bot tokens (or separate databases) for concurrent scenarios sharing
the same User target; otherwise serialize them. An active GET control for the
same method/path and owning Bot returns `409`, including when another Guild of
that Bot is supplied. No all-GET or wildcard selector is supported.

`status` is an integer from `400` through `599`; `code` is a nonnegative safe
integer; `message` is a nonempty string of at most 1000 characters. `times` is an
integer from `1` through `100`, defaulting to `1`. Invalid/malformed input returns
`400`. An already active legacy fault for the same method/path returns `409`.

On a matching authenticated request, Fauxcord atomically decrements `remaining`
and increments `consumed`, then returns the chosen status with exactly
`{"message":"...","code":...}`. The ordinary route does not run: no message
creation (including attachments and polls), deletion, ban/purge, member update,
role assignment, or corresponding Gateway mutation event happens. Authentication runs first (`401` attempts do not count);
the normal latency and rate-limit headers still apply. After exhaustion, requests
use the ordinary REST behavior, including ordinary validation and 404 responses.
Automatic library retries count as separate attempts. The control provides the
two-field Discord error body; specialized rate-limit retry fields are not modeled.

All three request prefixes (`/api/v10`, `/api`, and bare) match the same control.
Request query parameters are ignored. In particular, an audit-log fault selects the exact Guild's GET route
regardless of `action_type`, `limit`, `user_id`, `before`, `after`, parameter
ordering, or omitted parameters. These queries neither create separate targets
nor expand the path selector to other Guilds or routes. Queries in the configured
`path` are rejected with `400`.

Controls and counters are isolated per
database. `/_test/reset` clears them, and environment/Guild deletion cascades
them; Channel deletion also removes message-send and message-delete controls for
that Channel. Exhausted records remain inspectable until cleared, and a fresh control may then
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
Messages with stickers also include `sticker_items`, with the same catalog-derived
`id`, `name`, and `format_type` as ordinary message reads. The field is omitted
when there are no stickers.

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
| `avatar`        | —        | Optional user avatar hash (string or null). Omitted/null values use the default avatar.                       |
| `username`      | ✅       | Username.                                                                                                     |
| `discriminator` | —        | Defaults to `"0"`.                                                                                            |

The stored `global_name` appears in Discord user/member REST responses and
Gateway payloads, including the initial `GUILD_CREATE` member list and later
`GUILD_MEMBER_UPDATE` events from nickname PATCH requests. For example,
`{"username":"TestHuman","global_name":"Display Name"}` creates a user whose
global display name remains available when their guild nickname is cleared.
`POST /_test/setup` and `SEED_FILE` bot fixtures accept the same nullable field
as `user.global_name`.

To select a user avatar, supply its hash when registering the human fixture:

```bash
curl -X POST http://localhost:3000/_test/users \
  -H "Content-Type: application/json" \
  -d '{"id":"555555555555555556","username":"AvatarHuman","avatar":"0123456789abcdef0123456789abcdef"}'

curl http://localhost:3000/api/v10/users/555555555555555556 \
  -H "Authorization: Bot mytoken"
```

The native user GET returns the selected hash in `avatar`. After joining a Guild,
member GET/list responses expose it in `user.avatar`, as do Gateway
`GUILD_CREATE` members and `GUILD_MEMBER_ADD`, `GUILD_MEMBER_UPDATE` and
`GUILD_MEMBER_REMOVE` user objects. The member's top-level `avatar` is a separate
Guild-specific field and remains `null`. Animated hashes (with an `a_` prefix)
are also accepted. Fauxcord stores the string as supplied; it does not upload,
validate or host image assets.

For a default-avatar fixture, use `{"username":"DefaultHuman","avatar":null}`
or omit `avatar`. Non-string, non-null avatar values return `400 Bad Request`
without creating a user. An explicit ID collision still returns `409 Conflict`
and preserves the existing profile, including its avatar. The creation response
continues to contain only `id`, `username` and `discriminator`.

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
| `content`             | —        | Message content, up to 2,000 characters. Optional when valid stickers are supplied.                                               |
| `sticker_ids`         | —        | Up to three distinct existing sticker IDs as snowflake strings. Omitted, `null`, or `[]` means no stickers.                       |
| `author.id`           | ✅       | ID of a user already registered via `POST /_test/users` (or any other existing user). Returns `404` if unregistered.              |
| `id`                  | —        | Explicit numeric Message ID (1–20 digits), otherwise generated. An existing Message ID returns `409` without mutations or events. |
| `remove_after_create` | —        | Boolean, default `false`. Remove the message immediately after its native create dispatch is queued.                              |

**Stickers**

Create guild stickers through the existing `POST /guilds/:guildId/stickers`
catalog endpoint, then use the returned IDs. Sticker-only injection is supported:

```json
{
  "author": { "id": "555555555555555555" },
  "sticker_ids": ["666666666666666666"]
}
```

Guild stickers (type `2`) must be available and belong to the target channel's
guild. Human fixtures can also use standard stickers (type `1`) already seeded
in the local sticker-pack catalog. PNG (`1`), APNG (`2`), Lottie (`3`), and GIF
(`4`) format metadata are preserved; the existing guild creation endpoint
currently creates PNG metadata. This control does not upload or render sticker
assets, simulate Nitro entitlements, or permit external guild stickers. The
catalog starts empty: IDs from the live Discord catalog are not automatically
available locally.

Use string IDs to preserve snowflake precision. Non-arrays, numeric or malformed
IDs, duplicates, more than three IDs, missing catalog entries, unavailable or
foreign guild stickers, and unsupported catalog formats return `400` / `50035`
without creating a message, registering membership, or emitting events. Supplied
`sticker_items` objects are rejected: items are derived from catalog data, never
accepted from caller-provided names or formats. Content plus stickers is also
supported. Empty content with no stickers still fails.

The ordinary `POST /channels/:channelId/messages` endpoint also accepts
`sticker_ids`, including sticker-only messages, for available stickers in that
channel's guild. Bot REST creation does not support standard pack stickers or
external guild stickers; stickers cannot be combined with voice-message or
components-v2 flags. Existing authentication and prefix mounting apply.

Returned REST messages, single-message/history reads, `/_test/messages`, and
native `MESSAGE_CREATE` / `MESSAGE_UPDATE` payloads carry ordered `sticker_items`
containing exactly `id`, `name`, and `format_type`. `sticker_ids` is a creation
input field only. Metadata is snapshotted when sent, persists across database
reopening, and remains in retained messages after catalog edits or deletion.
Gateway delivery uses Fauxcord’s existing intent-gated broadcast behavior;
sessions are not filtered by guild membership. Sticker identity validation and
persistence cleanup are scoped to the target guild.
Content/embeds/flags edits preserve stickers; replacing/removing stickers through
message edits is unsupported. Message/channel/guild deletion and existing reset
controls cascade removal of message sticker snapshots. `remove_after_create`
works for sticker-only fixtures, returning the create snapshot even after actual
message deletion.

The limit and response shape follow Discord's
[Create Message documentation](https://docs.discord.com/developers/resources/message#create-message)
and [Sticker Item structure](https://docs.discord.com/developers/resources/sticker#sticker-item-object).

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
timestamp, embeds, attachments, sticker items, reactions, flags, and other fields
are preserved.

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

## `GET /_test/interactions/:interactionId/callback` — Observe the initial callback

Read-only observation of the bot's accepted initial REST callback, correlated to
one exact interaction. Use the `id`, `application_id`, and `token` returned by
`POST /_test/interactions` (also delivered in native `INTERACTION_CREATE`). Supply
`application_id` as a query parameter and the token in the `X-Interaction-Token`
header. No Bot authorization header is needed, like other test-control routes.
The interaction token is required for this lookup; a Bot token is not a substitute.

```http
GET /_test/interactions/123456789/callback?application_id=111111111111111111
X-Interaction-Token: <interaction token>
```

A known matching interaction returns `200`, with `Cache-Control: no-store`:

```json
{
  "interaction_id": "123456789",
  "application_id": "111111111111111111",
  "responded": true,
  "initial_callback_type": 5
}
```

| State                                                    | `responded` | `initial_callback_type`          |
| -------------------------------------------------------- | ----------- | -------------------------------- |
| Pending: no callback accepted yet                        | `false`     | `null`                           |
| Direct `CHANNEL_MESSAGE_WITH_SOURCE` accepted            | `true`      | `4`                              |
| Deferred `DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE` accepted | `true`      | `5`                              |
| Other accepted callback                                  | `true`      | Accepted callback type number    |
| Acknowledged before callback recording was introduced    | `true`      | `null` (unknown historical mode) |

`initial_callback_type` is the **response callback type**, not the incoming
interaction's `type` (normally `2` for a slash command). The mock currently accepts
callback types `1`, `4`, `5`, `6`, `7`, `8`, `9`, `10`, `12`, and `13`; only `4` and
`5` create originals when a channel is supplied. Recording other accepted types
does not extend their existing acknowledgement-only behavior.

A harness can poll while `responded` is `false`, then distinguish direct `4` from
deferred `5`. Any other type, or `true` with `null`, must be handled as a separate
or unknown mode. Read the original message separately for completed output:
`PATCH .../messages/@original` clears `LOADING` but never changes the recorded
initial type. Even if PATCH finishes before the first poll, observation still
reports `5`. Deleting the original also preserves the observation.

Acceptance and original-response state are recorded atomically in SQLite. Reads
do not acknowledge, create messages, emit Gateway events, or retry callbacks.
Malformed/rejected callbacks, wrong callback tokens, and retries rejected with
`40060` do not change the observation. It survives database reopen and is removed
with its interaction by test reset or setup deletion. Migrated acknowledged rows
remain unknown; Fauxcord never infers their mode from message flags or timing.
Type-4 callbacks validate the modeled message field types before acknowledgement:
`content` is a string, `tts` is a boolean, `flags` is an integer, and `embeds` is an
array of objects. These fields also accept `null` as an empty/default value.
This does not add validation or rendering for unmodeled callback features.

Missing/empty `application_id` or `X-Interaction-Token` returns `400`
(`{"message":"400: Bad Request","code":0}`). Unknown interaction IDs and any
mismatch of interaction ID, application ID, or token return the same `404`
(`{"message":"404: Not Found","code":0}`). No token is returned in success or
error bodies. Keep the token out of URLs, diagnostic output, and logs, including
HTTP header dumps. Tokens follow the existing interaction lifetime (expiry is
not modeled). This Fauxcord-specific route has no Discord OpenAPI manifest entry.

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

---

## Scoped Gateway capture, hold, release and replay

These unauthenticated test controls operate on native Gateway dispatches addressed
to one existing, connected session. An external HTTP test controller can use
only the registered bot user ID and its guild ID, without a bot token or access
to the bot process's READY callback. Omit `session_id` to resolve exactly one
open session belonging to that guild's registered bot setup. Connect the bot
before arming; a controller may retry `404` while waiting for its session to open.
Explicit `session_id` from `READY.d.session_id` remains supported when available.
There is no arbitrary dispatch/payload injection endpoint. These Fauxcord-only routes do
not have Discord OpenAPI manifest entries.

### `POST /_test/gateway-event-controls` — Arm a capture

```json
{
  "guild_id": "222222222222222222",
  "bot_id": "111111111111111111",
  "events": [
    "MESSAGE_DELETE",
    "MESSAGE_REACTION_ADD",
    "MESSAGE_REACTION_REMOVE"
  ],
  "hold": true,
  "limit": 20,
  "ttl_ms": 30000,
  "allow_original_sequence": false
}
```

Returns `201` with `id`, the resolved `session_id`, and the normalized policy.
`guild_id` and `bot_id` must be positive numeric strings of 1–20 digits. When
provided, `session_id` must be the 32-character hexadecimal ID returned by READY;
explicit null, empty, or malformed IDs return `400`.

The guild must belong to that registered bot, and the session must belong to
that bot, use the same setup token, and be open. Missing/mismatched scope,
no open owning session, or a stale explicit session returns `404`. Omitting
`session_id` with multiple open owning sessions returns `409` with
`{"message":"AMBIGUOUS_SESSION","code":0}`; choose an explicit session instead.
No candidate list, token, or credentials are returned. Sessions for another
setup sharing the same bot user ID do not qualify. Closed sessions retained for
normal resume are excluded. Resolution happens once when arming: every control
is pinned to the resolved session and socket and never follows a replacement.
After disconnect/replacement, create a fresh control; the returned ID identifies
the newly resolved session.

`events` is a nonempty, unique subset of `MESSAGE_DELETE`,
`MESSAGE_DELETE_BULK`, `MESSAGE_REACTION_ADD`, `MESSAGE_REACTION_REMOVE`,
`MESSAGE_REACTION_REMOVE_ALL`, and `MESSAGE_REACTION_REMOVE_EMOJI`. Only events
that the native producer actually emits are captured. Single deletion, native
bulk deletion through the REST endpoint below, reaction addition, and single
reaction removal have producers. Reaction-clear selectors are ready for
separately implemented native events; this feature adds no reaction-clear producer.

Capture runs after native intent filtering: missing Guild Messages / Guild
Message Reactions intent means no corresponding capture or delivery. Unrelated
event types, guilds, bots and other sessions keep their existing delivery
behavior. `hold` defaults to `false`: observe while delivering normally. With
`hold: true`, matching events are retained without sending or entering the
normal resume buffer. The database operation still completes immediately.
Payloads are copied at capture time, so message removal cannot invalidate a
late reaction payload, and duplicate deletion does not require a second DELETE.

`limit` is an integer from 1–100 (default 20); `ttl_ms` is an integer from
1–60000 (default 30000). Each control also has a fixed 256 KiB serialized payload
budget and a maximum of 100 total release/replay deliveries. There are at most
32 controls per assembled Gateway. Global capacity returns `429`. Overlapping
event selectors for the same guild/session return `409`. Invalid policy,
malformed JSON and explicit null policy values return `400`.

When count/byte capacity is reached, subsequent matching events **pass through
normally** and increment `skipped`; no entries are evicted and no more events
are held. Assertions should check `skipped === 0` when complete capture matters.
Expiry does not extend when a control is inspected or used.

### `GET /_test/gateway-event-controls/:id` — Inspect capture state

Returns `200` with the policy, `expires_at` (epoch milliseconds), `bytes`,
`skipped`, `operations`, and `events_captured` in native observation order:

```json
{
  "events_captured": [
    {
      "id": "CAPTURED_EVENT_UUID",
      "envelope": {
        "op": 0,
        "t": "MESSAGE_DELETE",
        "s": 2,
        "d": {
          "id": "123",
          "channel_id": "333333333333333333",
          "guild_id": "222222222222222222"
        }
      },
      "state": "held",
      "deliveries": 0,
      "last_sequence": null
    }
  ]
}
```

Each captured event has its own UUID. `state` is `held`, `delivered` (ordinary
native delivery), or `released`. `deliveries` counts server delivery attempts,
not client acknowledgements or completed callbacks. `last_sequence` is the last
attempted sequence. Inspection has no delivery side effects and exposes no bot
token. An unknown, expired, canceled or invalidated control returns `404`.

### `POST /_test/gateway-event-controls/:id/release` — Send held events

```json
{
  "event_ids": ["SECOND_CAPTURED_UUID", "FIRST_CAPTURED_UUID"],
  "sequence": "new"
}
```

`event_ids` must contain 1–100 unique captured event UUIDs, all still held by
this control. Events are sent synchronously in the requested order. Omitting an
event leaves it held. Returns `200` with updated observation. Unknown/cross-control
IDs return `404`; already delivered/released events return `409`. The complete
selection is validated before any send, so an invalid selection sends nothing.

### `POST /_test/gateway-event-controls/:id/replay` — Duplicate a delivered event

```json
{ "event_ids": ["RELEASED_OR_DELIVERED_UUID"], "sequence": "new" }
```

Replay accepts exactly one event from this control that was delivered normally
or released. A still-held event returns `409`; release it first. Replay keeps
its state and increments `deliveries`. It sends the captured payload directly:
no REST call, database mutation, or resource lookup is repeated. This includes
`MESSAGE_DELETE` after the message has already disappeared. Exhausting the
100-delivery budget returns `429` without sending.

For release and replay, `sequence` defaults to `new`: each send gets a fresh
monotonically increasing session sequence and is added to normal resume history.
Native capture itself consumes its original sequence even when held; consequently
holding/discarding can leave sequence gaps. Held originals never enter resume
history. Such intentionally omitted sequences may make resume from an older
sequence invalid under the ordinary bounded-buffer rules; these controls are
intended for a connected test session, not a resumable lossless queue.

`sequence: "original"` requires `allow_original_sequence: true` when arming the
control (`409` otherwise). It resends the exact captured envelope, including the
original sequence, without advancing the session sequence or adding to resume
history. Release order may deliberately decrease sequences, and replay may
repeat an old one; clients that reject these frames may not invoke callbacks.
Subsequent ordinary dispatches still advance from the session's high-water
sequence. Use `new` when testing duplicate callbacks rather than client sequence
handling. Malformed action JSON, duplicate IDs or invalid sequence mode returns
`400`; each successful action returns updated observation.

### `DELETE /_test/gateway-event-controls/:id` — Cancel and discard

Returns `204` for a known control and `404` otherwise. Cancellation drops all
held payloads and observation history without flushing them; already sent
frames remain sent. Expiry, socket disconnect, session removal/replacement,
resume onto a different socket, setup deletion, and `/_test/reset` do the same.
A nonempty-token reset clears only that setup's controls; an omitted/empty-token reset and
Gateway shutdown clear all. Controls are in memory and do not survive restart.
Deleted guild/bot scope is also invalidated before further capture or actions.

What is deterministic: native payload capture, bounded observation, explicit
release selection, and frame send order on one connected WebSocket. Poll
observation until the expected events appear, then select their UUIDs. A useful
scenario is to hold reaction ADD/REMOVE and DELETE, perform the real operations,
then release DELETE before the captured reactions. REST can confirm the message
is absent before release.

TCP frame ordering does **not** reproduce or control application handler
scheduling. Libraries may drop original-sequence frames, update caches before
callbacks, or run handlers concurrently. To prove one callback finished before
another starts, the consuming test harness needs its own application-level
barrier/acknowledgement; a release HTTP response alone proves only server queueing.
No artificial TCP packet reordering, sleeps, handler acknowledgements, arbitrary
forged dispatches, or general network chaos are modeled by these controls.

---

## Bulk-delete injected messages through Discord REST

Use `POST /api/v10/channels/:channelId/messages/bulk-delete` with the bot's
`Authorization` header and `{"messages":["MESSAGE_ID_1","MESSAGE_ID_2"]}` to
remove retained human or bot messages. Connect the owning application bot with
`GUILD_MESSAGES` and wait for READY first. Successful deletion queues one native
`MESSAGE_DELETE_BULK` payload with `ids`, `channel_id`, and `guild_id`; it queues
no per-message `MESSAGE_DELETE` events. Ordinary single DELETE still queues
`MESSAGE_DELETE`.

Following the [Discord bulk-delete documentation](https://docs.discord.com/developers/resources/message#bulk-delete-messages),
the endpoint accepts 2–100 unique Snowflake IDs in a guild channel. IDs may be
quoted strings or raw JSON integers (preserved without floating-point rounding).
Malformed bodies/IDs and duplicates return `400` / `50035`; invalid counts return
`400` / `50016`; any ID older than two weeks returns `400` / `50034`, even when
missing or belonging to another channel. Unknown channels return `404` / `10003`,
DM channels return `400` / `50024`, and normal bot authentication is required.
Invalid requests change no data and queue no deletion events.

Missing IDs count toward the limit and are ignored during deletion. IDs in other
channels and ephemeral interaction responses are also ignored; they are never
removed through this channel endpoint. Deletion and database cleanup of embeds,
attachment metadata, reactions, pins, polls, answers, and votes commit together
before dispatch. Attachment files on disk retain the same lifecycle as ordinary
single-message deletion.

Emulator limitations: Fauxcord does not enforce `MANAGE_MESSAGES` permissions.
Its guild model has one owning bot; bulk dispatch goes only to that bot's
sessions in this database with the Guild Messages intent. For partial requests,
`ids` contains only messages actually removed, in request order (possibly one
ID); all-missing requests return `204` without an event. Discord documents
missing-ID acceptance but does not specify its event contents for these cases;
this deterministic behavior lets tests distinguish actual deletions from no-ops.
