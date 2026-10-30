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

| Field                      | Required | Description                                              |
| -------------------------- | -------- | -------------------------------------------------------- |
| `token`                    | ✅       | Bot token (including the `"Bot "` prefix)                |
| `user.id`                  | —        | User ID (a Snowflake is auto-generated if omitted)       |
| `user.global_name`         | —        | Global display name (string or null; default: null)      |
| `user.username`            | —        | Username (default: `"MockBot"`)                          |
| `guilds`                   | —        | Array of Guilds to create                                |
| `guilds[].id`              | —        | Guild ID (auto-generated if omitted)                     |
| `guilds[].name`            | ✅       | Guild name                                               |
| `guilds[].icon`            | —        | Opaque icon hash string or null; default: null           |
| `guilds[].owner_id`        | —        | Registered non-bot user ID; defaults to the setup bot    |
| `guilds[].premium_tier`    | —        | Integer boost tier (`0`, `1`, `2`, or `3`); default: `0` |
| `guilds[].afk_channel_id`  | —        | Voice channel (type `2`) of this guild, or null; default: null |
| `guilds[].afk_timeout`     | —        | `60`, `300`, `900`, `1800` or `3600` seconds; default: `300` |
| `guilds[].channels`        | —        | Array of channels to create                              |
| `guilds[].channels[].id`   | —        | Channel ID (auto-generated if omitted)                   |
| `guilds[].channels[].name` | ✅       | Channel name                                             |
| `guilds[].channels[].type` | —        | Channel type (`0`: text, default: `0`; a reused channel ID keeps its stored type when omitted) |
| `guilds[].channels[].bitrate`            | — | Voice/stage only: bits per second; default `64000` |
| `guilds[].channels[].user_limit`         | — | Voice/stage only: `0` (unlimited) to `99` (voice) or `10000` (stage); default `0` |
| `guilds[].channels[].rtc_region`         | — | Voice/stage only: a `GET /voice/regions` ID, or null (automatic); default null |
| `guilds[].channels[].video_quality_mode` | — | Voice/stage only: `1` (auto) or `2` (full); default unset |

**Response**: The setup result (including any auto-generated IDs)

**Note**: Calling this twice with the same token returns `409 Conflict`.  
For subsequent calls, delete the existing data first via `/_test/reset` or `DELETE /_test/setup/:token`.

`guilds[].channels[].type` must be a non-negative integer when given; strings
such as `"2"` return `400`. `null` behaves like omission.

Reusing an existing channel ID updates that channel in place, with Discord's
channel-type rules: voice (`2`) and stage (`13`) channels cannot become other
types, other channels cannot become voice or stage channels, and a voice or
stage channel cannot move to another guild. Such requests return `400` with no
partial fixture state or Gateway events, so voice states can never be left
attached to a channel that no longer accepts them. Switching between voice and
stage (`2` ↔ `13`) remains a privileged fixture override. The ordinary Discord
`PATCH /channels/{channel.id}` rejects any `type` change on a voice or stage
channel and any change into one with `50035` (`BASE_TYPE_CHOICES`); other
`type` values there are still ignored.

### Native category parents

Use native `POST /guilds/{guild.id}/channels` and
`PATCH /channels/{channel.id}` to set `parent_id` for text (`0`), voice (`2`),
announcement (`5`), stage (`13`), forum (`15`) and media (`16`) channels.
The parent must be an existing category (`4`) in the same guild. Categories
cannot nest, including self-parenting and category/child cycles. Omission
preserves an existing parent; explicit `null` clears it. Creation defaults to
no parent. The contract applies under `/api/v10`, `/api` and bare paths.
Other types ignore `parent_id` on this creation endpoint; use the native thread
creation endpoints for threads and their originating-channel parents.
Both string Snowflakes and unquoted unsigned JSON integer tokens are supported,
including exact 19-digit IDs sent by
[discord.py](https://github.com/Rapptz/discord.py/blob/v2.7.1/discord/guild.py#L1290-L1293).
Integer parent IDs retain every digit before validation and are returned as
strings. Decimal and exponent notation are rejected for category parents.

Invalid parents return HTTP `400`, code `50035`, `Invalid Form Body`, with
`errors.parent_id._errors`. Fauxcord uses field code `CHANNEL_TYPE_INVALID`;
the precise subcode/message is a mock contract, not a verified live Discord
response. The category semantics and form-error envelope follow Discord's
[Create Guild Channel](https://docs.discord.com/developers/resources/guild#create-guild-channel),
[Modify Channel](https://docs.discord.com/developers/resources/channel#modify-channel)
and [error formatting](https://docs.discord.com/developers/reference#error-messages).
Rejected requests change no channel data and emit no Gateway events; successful
creates/moves/clears include the persisted parent in `CHANNEL_CREATE` or
`CHANNEL_UPDATE`.

Exact guild-channel POST and channel PATCH REST faults run before this parent
validation. A selected failure preserves all channel state and emits no native
mutation event, even for an invalid parent body. After exhaustion/removal, valid
create/move/clear retries use this parent contract; invalid retries return the
native field error. Fault counters and owner binding follow the separate REST
fault selector contract below.

`/_test/setup` does not set `parent_id`; create fixtures there and use the native
API to arrange them. Reusing channel IDs preserves existing parents and rejects
retyping or moving a category/child that would invalidate an affected category
relationship, rolling back the entire setup with HTTP `400`, code `0`,
`Invalid channel parent`, and `errors.parent_id`. Valid fixture renames and
changes whose final relationships remain valid are allowed. Setup compares
parent validity before and after the entire request, including originating
channels for existing threads. Only newly invalid relationships are rejected.
Pre-existing invalid parents remain unchanged, including during text/announcement
retypes; setup does not repair or newly reject state left by the out-of-scope
operations below.

Thread parents keep their separate meaning (the originating channel); this
change does not make them movable through `PATCH /channels/{channel.id}`.
Category child-count limits, permission synchronization, bulk position-update
parent handling remain outside this validation contract. Category deletion
already clears direct child parents atomically while preserving the children;
see [Category deletion preserves child channels](#category-deletion-preserves-child-channels)
for its scoped snapshots, voice preservation and Gateway contract.

### Voice channel settings and guild AFK fields

Voice (`2`) and stage (`13`) channels always carry `bitrate`, `user_limit` and
`rtc_region` in REST responses, `CHANNEL_CREATE`/`CHANNEL_UPDATE` and the
`GUILD_CREATE` channel list. The defaults are `64000`, `null` for `rtc_region`
(automatic), and `user_limit` `0` (unlimited) for voice or `10000` for stage
channels, the value real stage channels report.
`video_quality_mode` appears only once set, as on Discord ("1 when not
present"). Other channel types never carry these fields. Guilds always carry
`afk_channel_id` (default `null`) and `afk_timeout` (default `300`).

Validation follows Discord's documented ranges from
[Modify Channel](https://docs.discord.com/developers/resources/channel#modify-channel)
and [Modify Guild](https://docs.discord.com/developers/resources/guild#modify-guild)
and the responses observed from the live API:

| Field | Rule | Response when violated |
| ----- | ---- | ---------------------- |
| `bitrate` (voice) | `8000` to `96000`, `128000`, `256000` or `384000` at boost tier 0-3 (`VIP_REGIONS` not modeled) | `50035`, `NUMBER_TYPE_MIN`/`NUMBER_TYPE_MAX`, e.g. `int value should be less than or equal to 96000.` |
| `bitrate` (stage) | `8000` to `64000` | below the minimum: `50035`; above `64000`: JSON error `30052` `Bitrate is too high for channel of this type` |
| `user_limit` (voice) | `0` to `99` | `50035`, `int value should be less than or equal to 99.` |
| `user_limit` (stage) | any non-negative integer | values above `10000` are silently truncated to `10000` ([intended per Discord staff](https://github.com/discord/discord-api-docs/issues/5929)) |
| `rtc_region` | a `GET /voice/regions` ID or `null` | `50035`, `BASE_TYPE_CHOICES` |
| `video_quality_mode` | `1` or `2` | `50035`, `BASE_TYPE_CHOICES` |
| `afk_timeout` | `60`, `300`, `900`, `1800` or `3600` | `50035`, `BASE_TYPE_CHOICES` |
| `afk_channel_id` | a voice channel (type `2`) of the same guild, or `null` | `50035` (Discord's exact field code is undocumented; Fauxcord uses `CHANNEL_TYPE_INVALID`) |

Non-integer values return `NUMBER_TYPE_COERCE`. On the REST routes a channel
`type` given as a numeric string (e.g. `"2"`) is converted to the number before
any voice-specific validation, so its voice settings are applied. In setup, the AFK channel may
be defined in the same request. Voice settings on other channel types and
invalid values return `400` with a `message` and Discord-style field `errors`
(a stage bitrate above `64000` is reported as field code `BITRATE_TOO_HIGH`),
with no partial fixture state or Gateway events. When setup reuses an ID,
omitted fields keep their stored values and `null` restores the default (or
clears `afk_channel_id`). After applying a guild, setup re-validates every
stored voice and stage setting of that guild against the final channel type,
and the stored AFK channel against its final type: switching a channel between
voice and stage returns `400` if a kept value would fall out of range (for
example a stage `user_limit` above `99` on a channel becoming voice, or an AFK
channel becoming a stage channel). Replace or reset the value in the same
request. Lowering `premium_tier` keeps higher stored bitrates, as Discord does
when a guild loses boosts (only new writes are checked against the lower
ceiling).

The ordinary Discord routes accept the same fields: `POST
/guilds/{guild.id}/channels` and `PATCH /channels/{channel.id}` (voice settings
are ignored for other channel types, as on Discord), and `PATCH
/guilds/{guild.id}` (`afk_channel_id`, `afk_timeout`). A successful guild
modification that changes the guild dispatches native `GUILD_UPDATE` (the plain
guild object) to the owning bot's sessions with the `Guilds` intent. Deleting
the AFK channel clears `afk_channel_id` without a `GUILD_UPDATE`; Discord
documents only `CHANNEL_DELETE` for channel deletion, and no source shows a
`GUILD_UPDATE` for this case.

On Discord, users with `MOVE_MEMBERS` may join a voice channel whose
`user_limit` is reached ([Discord staff](https://github.com/discord/discord-api-docs/issues/58)),
everyone else is refused. Discord's REST voice-state routes cannot join or move
users at all (`channel_id` must be the stage channel the user is already in),
but Fauxcord's `PATCH /guilds/{guild.id}/voice-states/@me` and `/{user.id}`
accept any voice or stage channel, so the rule is applied there: a join or move
into a channel already holding `user_limit` connected users returns `403`
(`50013`) unless the joining user or the calling bot has `MOVE_MEMBERS` in that
channel (owners and administrators always do; a member with an active timeout
keeps only `VIEW_CHANNEL` and `READ_MESSAGE_HISTORY`, as on Discord). The
voice-state fixture API below remains a privileged override and never checks
the limit, so fixtures can model any occupancy. AFK auto-moves (Discord moving
idle users into the AFK channel after `afk_timeout`) depend on client idle
detection and are not simulated; use the fixture API to move a user into the
AFK channel explicitly.

To seed a guild icon, pass `guilds[].icon`, for example
`"a_0123456789abcdef0123456789abcdef"`. The value is stored verbatim and appears
in native guild GET responses and Gateway `GUILD_CREATE`, including on initial
connection and reconnect with IDENTIFY. This is a hash fixture; Fauxcord does
not upload images or serve icon CDN assets.

Omitting `icon` leaves new guilds at `null` and preserves the current icon when
setup reuses an existing guild ID under a different token. Explicit `null`
clears the icon; a string replaces it. Strings must be non-empty and have no
surrounding whitespace. Other values return `400`, with no partial fixture
state or Gateway events. Other guilds are unaffected. `SEED_FILE` accepts the
same field and validation through the shared setup service.

To prepare a boosted guild before connecting a client, pass
`guilds[].premium_tier`, for example `"premium_tier": 2`. The stored tier appears
in guild REST responses and Gateway `GUILD_CREATE` on initial connection and
reconnect with IDENTIFY. This fixture sets the tier only; other premium fields
(such as the subscription count) retain their existing mock defaults.

Omitting `premium_tier` leaves new guilds at `0` and preserves the current tier
when setup reuses an existing guild ID under a different token. An explicit
integer from `0` through `3` replaces it, including `0` to reset the tier. Null,
strings, booleans, fractions, and out-of-range numbers return `400` with no
partial fixture state or Gateway events. Other guilds are unaffected, and
`/_test/reset` retains the stored tier. `SEED_FILE` accepts the same field and
validation through the shared setup service. The ordinary Discord Modify Guild
endpoint does not change the boost tier.

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

Deletes the Bot, its OAuth2 access tokens and authorization codes and all of its related data (Guilds, Channels, Messages, Webhooks),
including guilds the bot already left or was removed from (those survive the removal
until their setup is deleted or the guild is deleted explicitly). This is silent: unlike deleting a guild through REST, no
`GUILD_DELETE` or other Gateway event is dispatched.
Guild-scoped audit-log fixtures, audit response controls, REST fault controls, and their consumption history are also removed.

```bash
curl -X DELETE "http://localhost:3000/_test/setup/Bot%20mytoken"
```

> If the token contains a space, like `Bot mytoken`, encode it as `%20`.

---

## `PATCH /_test/guilds/:guildId/voice-states/:userId` — Prepare a voice state

Create or update the voice state of an existing guild member, without Bot
Authorization or an active Gateway connection. This dedicated Fauxcord fixture
API accepts synthetic human/self flags. Discord's ordinary stage voice-state
PATCH contract does not accept arbitrary self flags such as `self_stream`:
see the [Discord voice resource](https://docs.discord.com/developers/resources/voice).

```bash
curl -X PATCH http://localhost:3000/_test/guilds/GUILD_ID/voice-states/USER_ID \
  -H "Content-Type: application/json" \
  -d '{"channel_id":"VOICE_CHANNEL_ID","self_stream":true,"emit":false}'
```

The response is `200` with the stored native voice-state object: `guild_id`,
`user_id`, `channel_id`, `session_id`, `deaf`, `mute`, `self_deaf`, `self_mute`,
`self_stream`, `self_video`, `suppress`, and `request_to_speak_timestamp`.
It has no embedded `member`. Existing authenticated
`GET /guilds/:guildId/voice-states/:userId` reads the same object (also under
`/api` and `/api/v10`). Fixture writes preserve users, memberships and other
members' voice states.

The read returns a stored state whether connected or disconnected
(`channel_id: null`). Without one, a guild member who has never joined voice
gets `404` / `10065` (`Unknown Voice State`), and a user who is not a member of
the guild gets `404` / `10007` (`Unknown Member`). The bot's own
`GET /guilds/:guildId/voice-states/@me` (or `%40me`) follows the same rule.
Authentication, unknown-guild (`10004`) and access (`50001`) errors come first.

Allowed input fields:

| Field                                                                             | Meaning                                                                                                                              |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `channel_id`                                                                      | Voice (type 2) or stage (type 13) channel in the same guild, or `null` to disconnect. Required on first creation.                    |
| `deaf`, `mute`, `self_deaf`, `self_mute`, `self_stream`, `self_video`, `suppress` | Strict JSON booleans. Defaults are `false`; omitted fields retain their existing values. Server `mute`/`deaf` default to the member. |
| `request_to_speak_timestamp`                                                      | Valid ISO8601 datetime with timezone, normalized to Discord timestamp format, or `null`. Defaults to `null`; omission preserves it.  |
| `emit`                                                                            | Strict boolean, defaults to `true`. `false` requests silent historical preparation even with active sessions.                        |

To join, send `{"channel_id":"VOICE_CHANNEL_ID"}`. To stream or stop streaming
while staying connected, send `{"self_stream":true}` or `{"self_stream":false}`.
To move, send another same-guild voice/stage `channel_id`; omitted flags survive
the move. To disconnect, send `{"channel_id":null}`. Disconnect clears
`self_stream`, `self_video` and `request_to_speak_timestamp` and retains other
flags. A disconnected state cannot enable streaming/video or set a nonnull
request timestamp. The session ID stays stable through flag changes, moves and
the disconnect response; rejoining after disconnect creates a fresh session.
IDs and session identity are server-owned and cannot be overridden.

Server `mute` and `deaf` belong to the guild member, as on Discord, where a
server mute survives reconnects. When omitted, they default to the member's
stored `guild_members.mute`/`deaf`, and every successful write copies the
committed values back to the member. `GET /guilds/:guildId/members/:userId`,
`GUILD_CREATE` members and the `member` embedded in `VOICE_STATE_UPDATE`
therefore always agree with the voice state. This mirroring is silent: the
fixture emits no `GUILD_MEMBER_UPDATE`. Use the production
[Modify Guild Member voice moderation](#server-voice-moderation-through-modify-guild-member)
to model the bot's own mute/deafen/move/disconnect actions.

### One voice connection per human user

A human user (`user.bot` is `false`) holds a single voice connection across all
guilds, as in the Discord client: joining a voice channel in one server leaves
the channel in another. Whenever a write leaves a human connected in guild B
(a join from no connection, a join from guild A, or any connected update),
every connected state of that user in another guild is disconnected first,
through the same path as `{"channel_id":null}`: the row is kept with
`channel_id: null`, the previous session ID is preserved, server `mute`/`deaf`
come from that guild's member (even if a legacy or directly inserted row
stored different values), and `self_stream`, `self_video` and
`request_to_speak_timestamp` are cleared. The disconnect and the write commit
in one transaction. The response still describes only the target guild's
state. Legacy rows of a user who is no longer a member of that guild are left
untouched: there is no member to resolve `mute`/`deaf` from, and such rows are
never published or listed in `GUILD_CREATE`.

With live delivery, guild A's bot receives `VOICE_STATE_UPDATE`
`channel_id: null` before guild B's bot receives the join. When one bot owns
both guilds, its sessions get the two events in that order with consecutive
sequence numbers, and voice capture controls on either guild record their
respective event. With `emit: false`, the same disconnect is applied silently,
so later `GUILD_CREATE` snapshots list the user only in guild B. Moves within
one guild and disconnects are unaffected.

Bot users are exempt: a bot may stay connected to one channel in each of
several guilds at once, because Discord voice connections are requested per
guild (the Gateway
[Update Voice State](https://docs.discord.com/developers/events/gateway-events#update-voice-state)
payload is keyed by `guild_id`). The rule applies to every write path,
including the authenticated `PATCH /guilds/:guildId/voice-states/:userId`
route.

User rows are global, so a human user ID seeded into guilds of different Bot
setups is one account. The disconnect then crosses setups, as in Discord: the
other setup's bot receives the leave even though it did not make the write.
The `/_test/reset` and setup-deletion scoping above still applies only to
cleanup. Use a distinct human user ID per setup when setups must not affect
each other's voice state.

Malformed JSON, nonobjects, unsupported fields and invalid values return `400`.
Missing guild, user, membership or channel returns Discord-style `404`; channels
in another guild return `404`, and non-voice/stage channels return `400`. All
validation finishes before mutation. `{}` is a no-op for an existing valid state.

Successful live changes publish native `VOICE_STATE_UPDATE` after persistence.
Join, stream start/stop, moves, other flag changes and disconnects are delivered
only to sessions with `GuildVoiceStates` for the guild's registered Bot token
and originating app/database. `Guilds` and `GuildMembers` are not required for
live voice events. The event includes the full native state plus `member.user`;
disconnect uses `channel_id: null` with the previous voice session ID. Client
libraries such as DiscordGo derive `BeforeUpdate` from their own cache; it is
not a wire field.

`emit: false` persists a historical fixture without any live event, even with
active sessions. Rejected writes, unchanged patches, repeated disconnects and
flag-only edits while disconnected emit nothing and consume no Gateway
sequence. Normal delivery uses the existing sequence/replay buffer, so RESUME
replays missed voice events with their original data and sequence.

Prepared connected states also appear in `GUILD_CREATE` after initial or
fresh IDENTIFY, with active members included for identity lookup. See
[Discovering prepared voice states on connection](gateway-voice-history.md)
for setup, payload shape, reconnect and cleanup behavior. RESUME replays
missed events rather than rebuilding that snapshot. No audio/video transport
is provided.

The existing authenticated stage PATCH routes also publish committed changes
through this path. Their writable fields are `channel_id`, `suppress` and
`request_to_speak_timestamp`; use the fixture API for synthetic self flags.

Voice fixtures are cleared by `/_test/reset`: a nonempty token scopes deletion
to that Bot's guilds, and omission/empty token clears all voice states. Setup,
guild, user and membership deletion silently remove affected states. Other
setups and memberships remain intact.

### Channel deletion disconnects members

Deleting a voice (type 2) or stage (type 13) channel with
`DELETE /channels/:channelId` disconnects every member connected to it, as real
Discord does. Each affected state is changed exactly like a
`{"channel_id": null}` fixture patch: it is retained with `channel_id: null`,
the same voice `session_id` and other flags, while `self_stream`, `self_video`
and `request_to_speak_timestamp` are cleared. One native `VOICE_STATE_UPDATE`
(with `member`) is published per member through the normal voice path, so the
`GuildVoiceStates` intent, Bot/token scoping, sequencing, RESUME replay and
`VOICE_STATE_UPDATE` capture controls all apply. Members connected to other
channels, already disconnected states and other guilds are untouched. Text and
other non-voice, non-category channels emit only `CHANNEL_DELETE`; category
deletion also updates its children as described below.

Ordering is deterministic: the disconnects are sent first, in ascending numeric
`user_id` order, followed by `CHANNEL_DELETE`. All-digit IDs compare by value
(leading zeros ignored, ties broken by raw text); any non-decimal IDs that a
fixture stored follow in raw text order. Discord's
[gateway events documentation](https://docs.discord.com/developers/events/gateway-events)
documents both events but neither this cascade nor an ordering guarantee;
Fauxcord emits disconnects first so client libraries can still resolve the
previous channel from their cache when handling them. Do not depend on this
order when the same code must also run against real Discord.

The deletion and disconnects are committed in one transaction before any event
is published. `/_test/reset`, setup cleanup and guild deletion remain silent.

### Category deletion preserves child channels

Authenticated `DELETE /channels/:channelId` (also under `/api` and `/api/v10`)
returns the deleted category object with status `200`. Its surviving direct
children in the same guild have `parent_id: null` in channel GET, guild channel
lists and subsequent Gateway `GUILD_CREATE` snapshots. Their IDs, messages,
permission overwrites and voice/stage connections remain intact. Threads under
a surviving child keep that child as their parent. Other categories and guilds
are unaffected. A missing or already deleted category returns `404` (`10003`,
`Unknown Channel`) without further mutations or events.

One full `CHANNEL_UPDATE` is published for each detached child and one
`CHANNEL_DELETE` for the category, using the `Guilds` intent. Child snapshots
are scoped to the guild's registered bot ID, setup token and originating
database, just like permission-overwrite updates. Other bot identities, other
tokens sharing the same bot ID, and other app databases receive no child
snapshots. Delivery follows the guild's registration, not the REST caller's
token. This follows Discord's explicit
[Delete/Close Channel contract](https://docs.discord.com/developers/resources/channel#deleteclose-channel).
Fauxcord commits all parent changes and deletion in one transaction before
publishing any event. It sends child updates in `position, id` order before the
category deletion; Discord does not document an ordering guarantee. Category
deletion emits no voice disconnect events for the surviving children.

No new test control is required: create the hierarchy through native guild
channel creation with `parent_id`, then delete the category through native REST.
The voice-state fixture above can prepare connected members. `/_test/reset`
silently clears voice states and messages while preserving the channel
hierarchy; guild/setup deletion still removes the entire hierarchy through
existing cleanup. Parent assignment follows the
[native category parent contract](#native-category-parents). Channel
create/delete broadcasts retain their existing behavior.

### Member removal disconnects voice

Removing a connected member through the Discord API publishes the voice
disconnect real Discord sends, before the member removal event:

| Removal                                   | Gateway events, in order (all with consecutive `s`)                                                  |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `DELETE /guilds/:guildId/members/:userId` | `VOICE_STATE_UPDATE`¹, `GUILD_MEMBER_REMOVE`                                                         |
| `PUT /guilds/:guildId/bans/:userId`       | `GUILD_BAN_ADD`³, `VOICE_STATE_UPDATE`¹, `GUILD_MEMBER_REMOVE`²                                      |
| `POST /guilds/:guildId/bulk-ban`          | per banned user, in `user_ids` order: `GUILD_BAN_ADD`, `VOICE_STATE_UPDATE`¹, `GUILD_MEMBER_REMOVE`² |

1. Only when the member had a connected voice/stage state, meaning its channel
   is a voice or stage channel of the same guild (the rule
   `GUILD_CREATE.voice_states` uses; legacy rows pointing elsewhere count as
   not connected). The payload has the
   same semantics as a fixture disconnect: `channel_id: null`, the previous
   voice `session_id`, `self_stream`/`self_video` `false`,
   `request_to_speak_timestamp: null`, server `mute`/`deaf` from the member,
   other flags (`self_mute`, `self_deaf`, `suppress`) unchanged, and the
   departing member's `member` object read before deletion. Members without a voice state, or with a kept
   disconnected state (`channel_id: null`), get no voice event.
2. Only when the banned user was a member.
3. Only when the ban is new. Banning a non-member publishes only
   `GUILD_BAN_ADD`. Re-banning an already banned user returns `204`, publishes
   nothing and keeps the original reason (the new reason is ignored). It also
   leaves the membership and voice state of a banned user who rejoined through
   a test fixture untouched (real Discord does not let banned users rejoin);
   only the requested message deletion runs, since Discord's behavior there
   has not been observed.

`GUILD_BAN_ADD` carries `guild_id`, `user` and `delete_message_secs`, the
ban's effective message deletion window in seconds (from
`delete_message_seconds` or the legacy `delete_message_days`; `0` when
omitted). The field is absent from the official docs but sent by real Discord
and documented by [Discord Userdoccers](https://docs.discord.food/gateway/gateway-events).

Bulk ban accepts `delete_message_seconds` (integer `0`–`604800`, otherwise
`400` with code `50035` and no bans) and deletes each newly banned user's
recent guild messages like a single ban. It reports unknown users and users
that are already banned in `failed_users`, without changes or events. When no user could be banned, it
returns `400` with `{"message": "Failed to ban users", "code": 500000}`
instead of a body, as documented for
[Bulk Guild Ban](https://docs.discord.com/developers/resources/guild#bulk-guild-ban).

Each event uses its own intent (`GuildVoiceStates`, `GuildMembers`,
`GuildModeration`) and is delivered to the guild's registered Bot token and
app database only. Events use normal sequencing and the replay buffer, so
RESUME replays them, and `VOICE_STATE_UPDATE` capture/hold/release/replay
controls see the removal disconnect like any other voice transition. The
voice-state row is deleted with the membership.

Discord documents the event set ("Sent when a user is removed from a guild
(leave/kick/ban)" for `GUILD_MEMBER_REMOVE`, "Sent when a user is banned from
a guild" for `GUILD_BAN_ADD`, see the
[Gateway events reference](https://docs.discord.com/developers/events/gateway-events))
but not the relative order of these events. The ban order above, the silent
re-ban and the bulk-ban `500000` response were observed on real Discord
(October 2026) by banning a member connected to a voice channel. The kick
order was not observed and follows the ban: the voice disconnect precedes
`GUILD_MEMBER_REMOVE`, so a client sees the member leave voice while still
cached as a member.

Known differences from that observation:

- Real Discord omits `self_stream` from the disconnect payload; Fauxcord sends
  `false`, like every other fixture disconnect.
- Real Discord also sends `THREAD_MEMBERS_UPDATE`,
  `VOICE_CHANNEL_START_TIME_UPDATE` and `VOICE_CHANNEL_STATUS_UPDATE` between
  the ban and the member removal, and `GUILD_AUDIT_LOG_ENTRY_CREATE` afterwards.
  Fauxcord emits none of these.
- Discord only sends `GUILD_BAN_ADD` to bots with `BAN_MEMBERS` or
  `VIEW_AUDIT_LOG`. Fauxcord does not model that check, because bans can only
  be created by the guild's own bot through REST.

Test cleanup stays silent: `/_test/reset`, `DELETE /_test/setup/:token` and
`DELETE /guilds/:guildId` remove memberships and voice states without any
`VOICE_STATE_UPDATE`, `GUILD_MEMBER_REMOVE` or `GUILD_BAN_ADD`. Leaving,
kicking or banning the guild's own bot follows
[Remove a guild from the bot](#remove-a-guild-from-the-bot-through-discord-rest-guild_delete)
instead: a connected bot gets its own voice disconnect first, then
`GUILD_MEMBER_REMOVE` and `GUILD_DELETE`, and the guild keeps every other
membership and voice state. In a bulk ban that also names the bot, the other
users' events come first, then the bot's voice disconnect (when connected),
`GUILD_MEMBER_REMOVE` and `GUILD_DELETE`.

### Shared service contract for Gateway integrations

`src/services/voice-states.ts` exports:

- `GuildVoiceState`, extending `APIVoiceState` with required `guild_id` and
  boolean `self_stream`, without embedded `member`.
- `getGuildVoiceState(db, guildId, userId)`, returning a stored state or `null`,
  including a retained disconnected state. Also re-exported by `guild-advanced.ts`
  for the existing REST routes.
- `getGuildVoiceStates(db, guildId)`, returning all connected states sorted by
  `user_id`, with no member-count limit. Inner joins exclude missing guilds,
  users, memberships, channels, cross-guild channels and channels other than
  voice/stage. Legacy nullable `self_stream` serializes as `false`.
- `toGuildVoiceState(row)`, the shared SQLite-to-native serializer.
- `toDisconnectedVoiceState(previous)`, the shared fixture-disconnect form
  (session and flags kept; channel, streaming, video and request-to-speak
  cleared), used for the disconnect of a member removed from the guild.
- `setTestGuildVoiceState(db, guildId, userId, input)`, validating untrusted
  input and returning `{ state, previous, changed, emit }` after its transaction
  commits, or `INVALID_INPUT`, `UNKNOWN_GUILD`, `UNKNOWN_USER`, `UNKNOWN_MEMBER`,
  `UNKNOWN_CHANNEL` before writes. The route returns only `state`. A native
  publisher can use `changed && emit` after success; this service emits nothing.
- `applyGuildVoiceStatePatch(db, guildId, userId, patch)`, the same
  transaction for an already validated `TestVoiceStatePatch`. It is shared by
  the fixture, stage and Modify Guild Member voice moderation paths, channel
  deletion and cross-guild displacement (each displaced guild is disconnected
  with a nested `channel_id: null` patch, reported in `displaced`), and mirrors
  server `mute`/`deaf` into `guild_members`.
- `updateGuildMember(db, guildId, userId, params)` in
  `src/services/guild-members.ts` mirrors the opposite direction: non-null
  `mute`/`deaf` are written onto a stored voice state in the same transaction,
  and a changed connected state publishes `VOICE_STATE_UPDATE` after
  `GUILD_MEMBER_UPDATE`. Voice connection and permission rules are applied only
  by the REST route.
- `disconnectGuildVoiceChannelMembers(db, channelId)`, disconnecting every
  valid member connected to a voice/stage channel with the same semantics as a
  `channel_id: null` fixture patch and returning the mutations in numeric
  `user_id` order (`compareUserIds(left, right)`, also exported).
  `deleteChannel` calls it inside its deletion transaction and publishes the
  results before `CHANNEL_DELETE`; it emits nothing itself.

`src/services/voice-state-events.ts` exports
`publishGuildVoiceStateMutation(db, mutation)`. The fixture and stage routes
and channel deletion call it after the shared storage transaction returns
successfully. It attaches the existing member/user, resolves the guild's
Bot/token scope and emits the typed `voice.state.update` domain event. Gateway subscriptions filter it by
database, token and intent before normal dispatch sequencing.
`publishRemovedMemberVoiceDisconnect(db, previous, member)` publishes the
disconnect for a member removed from the guild through the same
`publishVoiceStateSnapshot` publisher, injecting the member snapshot read
before deletion; it ignores disconnected states.
`src/services/voice-state-publisher.ts` also exports
`getGuildDispatchScope(db, guildId)`, which resolves the shared Bot/token
scope.

`src/services/member-removal.ts` exports `snapshotDepartingMember`,
`deleteGuildMembership`, `publishMemberDeparture`, `publishGuildBanAdd` and
`removeGuildMember` (kick). Any new non-cleanup member removal should snapshot
the member before deleting it and call `publishMemberDeparture` after commit.

`src/validators/voice-state.ts` exports `TestVoiceStatePatch` and
`validateTestVoiceState(input)`, which returns normalized typed input or `null`.
The `/_test/*` route is excluded from the Discord spec manifest by the existing
Fauxcord-only route policy.

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
retained attachment files and download metadata (including deleted-message uploads),
voice-state fixtures, audit-log fixtures, audit response controls, and all REST fault controls (including exhausted controls and consumption history).

### Reset only a specific Bot's data

```bash
curl -X POST http://localhost:3000/_test/reset \
  -H "Content-Type: application/json" \
  -d '{"token": "Bot mytoken"}'
```

Only messages sent by that Bot and Webhooks/Invites belonging to that Bot's Guilds are deleted.
REST fault controls in that Bot's Guilds are also deleted, including controls targeting
human-authored messages, global user reads, and DM channel creation.
Audit-log fixtures are cleared by the target Guild's Bot token,
regardless of their actor or target author. Voice states in that Bot's Guilds are also cleared. Other Bots' Guilds keep their controls and audit history.

---

## `POST /_test/guilds/:guildId/roles` — Create a managed role fixture

Creates a role in an existing guild without Bot authentication. Use this when
testing client-side checks that reject integration-managed roles, such as shop
role validation. A separate creation endpoint keeps the fixture contract small
and works with guilds already registered through `/_test/setup` or native REST;
setup payloads and native role creation do not gain a writable `managed` field.

```bash
curl -X POST http://localhost:3000/_test/guilds/222222222222222222/roles \
  -H "Content-Type: application/json" \
  -d '{"name":"Managed shop role","managed":true}'
```

| Field | Required | Description |
| ----- | -------- | ----------- |
| `name` | Yes | Role name, a string of 1–100 characters |
| `managed` | No | Boolean; defaults to `false`. Use `true` for an integration-managed fixture |

Returns **`201 Created`** with the complete Discord-shaped role object (no
wrapper), including an auto-generated string `id`, the supplied `name`, and
the stored boolean `managed`. Other fields use the ordinary role defaults:
`permissions: "0"`, `color: 0`, `hoist: false`, `mentionable: false`, and a
position one above the guild's current maximum. Each request creates a new role;
there is no fixture update endpoint. Only `name` and `managed` are accepted.
Caller-supplied IDs, permissions, positions and other fields are rejected.

Malformed/empty JSON, non-object bodies, invalid fields (including `null` or
string/number substitutes for `managed`) and unsupported fields return **`400`**.
Malformed JSON/non-object bodies use `{ "message": "400: Bad Request", "code": 0 }`;
field validation uses code `50035`, `Invalid Form Body`, with `errors.<field>._errors`.
An unknown guild returns **`404`**, code `10004`, `Unknown Guild`.
The existing 250-role limit (including `@everyone`) applies: a full guild returns
**`400`**, code `30005`, `Maximum number of guild roles reached (250)`.
Rejected requests store nothing and emit no events.

Successful creation emits the usual `GUILD_ROLE_CREATE` through the Gateway for
subscribed clients with the `GUILDS` intent. Its role snapshot, native
`GET /guilds/:guildId/roles`, native guild responses, later `GUILD_CREATE`
snapshots and `GUILD_ROLE_UPDATE` snapshots all report the stored `managed`
boolean. Native routes work under `/api/v10`, `/api`, and bare paths.
Creation does not assign the role to a member.

Like ordinary roles, these fixtures survive both global and token-scoped
`POST /_test/reset`, which retains role registrations. Deleting the guild or
its setup (`DELETE /_test/setup/:token`) removes its roles through the existing
cleanup; other guilds' roles remain intact.

### Managed-role fidelity boundaries

Discord's [role structure](https://docs.discord.com/developers/topics/permissions#role-object)
defines `managed` as integration ownership metadata. Its documented
[Create Guild Role](https://docs.discord.com/developers/resources/guild#create-guild-role)
and [Modify Guild Role](https://docs.discord.com/developers/resources/guild#modify-guild-role)
parameters do not include `managed`. Fauxcord therefore ignores that field on
native POST/PATCH: POST always creates an unmanaged role, and PATCH preserves
the existing managed flag.

This fixture represents the flag only: it does not create an integration, bot
association, role tags (`tags` remains `{}`), or automatic membership/lifecycle.
The documented [member-role add/remove](https://docs.discord.com/developers/resources/guild#add-guild-member-role),
role edit and [role delete](https://docs.discord.com/developers/resources/guild#delete-guild-role)
endpoints specify permissions but do not define managed-specific rejection
conditions or error responses. Fauxcord deliberately retains its existing
behavior for these operations, including `PATCH` member role lists:
managed roles can still be assigned, removed, edited and deleted. It does not
guess a blanket `403` or managed-role immutability rule. These operations are
not suitable for testing Discord's integration-role enforcement; use the fixture
to test applications that inspect `managed` themselves.

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

## `POST /_test/audit-log-responses` — Return deliberately unusual audit entries

Use this separate control for client robustness tests that must **receive** an
unexpected action type or malformed entry fields. The ordinary
`POST /_test/guilds/:guildId/audit-logs` fixture still requires valid
`MESSAGE_DELETE` entries and does not accept this data.

```bash
curl -X POST http://localhost:3000/_test/audit-log-responses \
  -H 'Content-Type: application/json' \
  -d '{
    "bot_id": "111111111111111111",
    "guild_id": "222222222222222222",
    "query": {"action_type": 72, "limit": 10},
    "entries": [
      {"id": "invalid", "action_type": 73, "options": null},
      {"action_type": 72, "options": {"channel_id": 42, "count": "NaN"}},
      {"id": null, "action_type": 72}
    ],
    "times": 1,
    "ttl_ms": 60000
  }'
```

A successful creation (or identical keyed retry) returns `201` with the normalized configuration and
`id`, `remaining`, `consumed`, `state`, `expires_at`, and `consumed_at`.
Initially `remaining` equals `times`, `consumed` is `0`, `state` is `armed`,
and `consumed_at` is `null`. Credentials are never included in this response.

| Field           | Contract                                                                                                                                                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ownership_key` | Optional opaque string of 1–128 ASCII letters, digits, underscores, or hyphens; see recoverable ownership below.                                                                                                              |
| `bot_id`        | Required canonical, nonzero unsigned 64-bit snowflake string identifying a registered bot that owns the selected guild.                                                                                                       |
| `guild_id`      | Required canonical, nonzero unsigned 64-bit snowflake string identifying an existing guild owned by that bot.                                                                                                                 |
| `query`         | Required object specifying the exact audit GET query. Supported keys: `action_type`, `limit`, `user_id`, `target_id`, `before`, `after`. Use `{}` to select a request with no query parameters.                               |
| `entries`       | Required array of 0–100 objects. Each entry may contain only `id`, `action_type`, `user_id`, `target_id`, and `options`. Every field may be omitted; its value may be any JSON value, subject to the size/depth bounds below. |
| `times`         | Optional integer from 1–100; defaults to 1.                                                                                                                                                                                   |
| `ttl_ms`        | Required integer from 1–60000, measured from creation using the server's wall clock.                                                                                                                                          |

Control policy is validated independently of response contents. Query IDs use
normal audit-query snowflake validation (including `"0"`); `action_type` must
be a supported Discord action and `limit` must be 1–100. `action_type` and
`limit` accept canonical decimal strings or integer numbers and normalize to
numbers. Query IDs must be strings. Unknown fields in the control, query, or
entry object are rejected. Entry values deliberately bypass audit-fixture
validation: IDs can be absent, null, numeric, or noncanonical strings;
`action_type` can be unexpected; `options`, `channel_id`, and `count` can be
missing or have incorrect types or values. Nested option objects may have
arbitrary keys. No referenced user or channel registration is required for
these intentionally unusual values.

The entire POST body is limited to 65536 UTF-8 bytes; its parsed, compact JSON
representation must also fit that bound. Entry values have at most ten nested
levels below the entry object (direct fields are level one). Non-finite numeric
values are rejected. This is an audit-entry control, not an arbitrary HTTP
response mechanism: it cannot change status codes, headers, companion lists,
other REST resources, or the top-level response shape.

The selector applies only to the owning bot's authenticated
`GET /guilds/:guildId/audit-logs`, across `/api/v10`, `/api`, and bare prefixes.
Query parameter order does not matter. Absent fields remain absent: `{}` does
not match `?limit=50`, and `{ "action_type": 72 }` does not match an unfiltered
read. All query values must match after normalization. Extra parameters,
repeated parameters (even with equal values), and invalid queries never consume
this control. Such reads follow the existing endpoint's normal query behavior.
Other bots, guilds, HTTP methods (including `HEAD`), and routes never consume it; existing
unauthenticated and missing-access errors still apply. Ownership is checked
again at consumption. Existing REST fault controls run first: a faulted request
does not consume an audit response control.

On each matching read, Fauxcord atomically decrements `remaining`, increments
`consumed`, and records the latest consumption time in `consumed_at`. It returns
HTTP `200` with `audit_log_entries` exactly equal to `entries`, preserving order,
JSON values, and absent fields. The companion arrays (`users`, `integrations`,
`webhooks`, `guild_scheduled_events`, `threads`, `application_commands`, and
`auto_moderation_rules`) are empty. Deliberately unusual entries bypass **all**
action/user/target/cursor filtering, ordering, and page-size truncation: even
`action_type=72` can return action `73`, and the configured array can exceed the
selected `limit`. This explicit deviation is what allows negative attribution
tests. Requests without a matching active control retain ordinary fixture
filtering, ordering, pagination, referenced users, and validation.

### Recoverable ownership and ambiguous POST outcomes

For harnesses that need cleanup even if the POST response is lost, truncated,
undecoded, or canceled, generate and retain a fresh unpredictable `ownership_key`
(such as a UUID) **before** sending POST. Include it with the normal configuration.
Keys are case-sensitive and unique for the entire SQLite database, across all
bots, guilds, and selectors. Different databases have independent namespaces.
Existing clients can omit the key and keep using the generated ID unchanged.

Recover configuration, the generated ID, and current evidence with:

```text
GET /_test/audit-log-responses/by-key/<ownership_key>?bot_id=<bot_id>&guild_id=<guild_id>
DELETE /_test/audit-log-responses/by-key/<ownership_key>?bot_id=<bot_id>&guild_id=<guild_id>
```

Both routes require exactly one canonical, nonzero `bot_id` and `guild_id`, and
no additional query fields. Invalid keys/scopes or duplicate fields return `400`.
GET returns `200` with the same configuration/evidence as ID-based inspection,
including `ownership_key`, and `Cache-Control: no-store`. Unknown or closed keys
and mismatched bot/guild scopes return `404`. Possession of the key and its
original scope permits recovery and cleanup even if the guild's token changes
or the guild/setup is removed; these are trusted test-control routes, with the
same unauthenticated access model as the existing ID-based controls. Keys are
ownership handles, not an authorization boundary. Do not share or reuse them
between independent harness runs.

An identical keyed POST retry returns `201` with the original ID and **current**
counters, timestamps, and state, including expired/exhausted controls. It never
extends TTL or resets consumption. Comparison uses normalized query values and
`times` (including its default), exact TTL, and JSON entry values. Object key
order is ignored at every nesting level; array order and missing versus null
fields remain significant. A changed payload, bot/guild scope, or current exact
guild-owner token returns `409`, without changing the original. Keyed controls
can only be consumed by the exact token bound at creation, as well as the
existing bot/guild/query checks. A fresh key can arm an expired/exhausted selector;
retrying the old key continues to address only the old control. Validation,
unknown-scope, and active-selector conflicts never reserve a new POST key.

DELETE by key atomically removes only that key's configuration and consumption
evidence and permanently closes the key. It returns `204` on repeated cleanup.
For an unknown key with an existing valid bot/guild owner scope, it also returns
`204` and reserves a closed key: **cleanup may arrive before the original POST**,
and that delayed POST will return `409`. Unknown keys with nonexistent/mismatched
owner scopes return `404` without reservation. A key already bound to a different
bot/guild returns `404` and is untouched. Cleanup never deletes a different
control selected by the same query, ordinary audit fixtures, messages, or guild
state. If cleanup's response is lost, retry the same DELETE.

Closure also applies to ID-based deletion, reset, guild deletion, and setup
deletion. Later POSTs with a closed key return `409`, even after recreating the
original guild/bot. Use a new key to arm again. SQLite retains only a small
reservation (key, original bot/guild IDs, token hash, and a null control link)
after cleanup; no entries, query, TTL, counters, or consumption timestamps remain.
Reservations persist across restarts and are intentionally not TTL-pruned or
removed by reset, because forgetting them would allow a delayed POST to recreate
a cleaned control. They accumulate for the lifetime of the database; a fresh
database starts a new ownership namespace. No guarantee survives replacing,
restoring an older copy of, or manually purging the database. The server must
remain reachable for cleanup retries; cancellation alone cannot undo a POST.

### Inspection, exhaustion, expiration, and cleanup

- `GET /_test/audit-log-responses/:id` returns `200` with the configuration and
  current counters, with `Cache-Control: no-store`. Consumption is server-side
  request evidence, not proof that a client received or processed the body.
- The last permitted read changes `state` to `exhausted`. Later reads use the
  normal audit response. Concurrent reads cannot exceed `times`.
- At `expires_at`, an unexhausted control becomes `expired` and cannot be
  consumed. Expiration leaves the remaining-use count and consumption evidence
  intact. Exhausted controls keep `state: "exhausted"` after their deadline.
- Only one active control may select a given bot/guild/query. A duplicate without
  an identical ownership key returns `409`; a different exact query may coexist.
  Exhaustion or expiration permits rearming the same selector with a new control ID.
- `DELETE /_test/audit-log-responses/:id` returns `204`, removing both the control
  and evidence. Normal fixtures then become visible again. Unknown/removed IDs
  return `404` on inspection or deletion.
- `/_test/reset` removes all controls and evidence, including exhausted and
  expired controls, and ordinary audit fixtures. A nonempty `token` restricts
  cleanup to that bot's guilds; an omitted/empty token clears all. Other bots'
  controls survive a scoped reset.
- Guild deletion and `DELETE /_test/setup/:token` remove scoped controls and
  evidence through database cascades. Channel deletion does not remove this
  guild-scoped control or historical audit fixtures.

Controls and counters persist in SQLite across server restarts, with the
original absolute expiration deadline. There is no scheduled dispatch or client
clock synchronization; retained evidence persists until explicit cleanup.
Remove controls in harness cleanup. Creating fixtures or creating, reading,
consuming, or deleting response controls does not delete messages or emit
Gateway events. The integration tests exercise real HTTP, SQLite state, and an
identified WebSocket Gateway session. Handler scheduling, exact application
clock boundaries, and the bot application's Harness are outside this API.

Creation errors use `{ "message": "400: Bad Request", "code": 0 }` for invalid
JSON, scope syntax, selector policy, entries structure, or bounds (`400`);
`{ "message": "413: Payload Too Large", "code": 0 }` for an oversized raw body
(`413`); `{ "message": "404: Not Found", "code": 0 }` for an unknown guild,
unknown bot, or a bot that does not own the guild (`404`); and
`{ "message": "409: Conflict", "code": 0 }` for an active selector duplicate,
a conflicting keyed retry, or a closed ownership key (`409`).
Inspection/deletion of an unknown control uses the same generic `404` body.
These infrastructure endpoints require no authentication, like the existing
test-control API; the selected Discord REST read still requires bot auth.

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
| `POST`   | `/users/@me/channels`                               | DM channel creation         |
| `PATCH`  | `/channels/{channelId}`                             | Guild channel edit          |
| `POST`   | `/guilds/{guildId}/channels`                        | Guild channel creation      |
| `DELETE` | `/channels/{channelId}/messages/{messageId}`        | Triggering-message deletion |
| `PATCH`  | `/channels/{channelId}/messages/{messageId}`        | Exact message edit          |
| `DELETE` | `/channels/{channelId}`                             | Channel deletion            |
| `PUT`    | `/guilds/{guildId}/bans/{userId}`                   | Ban creation                |
| `PATCH`  | `/guilds/{guildId}/members/{userId}`                | Member update / mute        |
| `PUT`    | `/guilds/{guildId}/members/{userId}/roles/{roleId}` | Mute-role assignment        |
| `DELETE` | `/guilds/{guildId}/members/{userId}/roles/{roleId}` | Mute-role removal           |
| `GET`    | `/guilds/{guildId}/audit-logs`                      | Deletion audit-log reads    |
| `GET`    | `/guilds/{guildId}/members/{userId}`                | Member reads                |
| `GET`    | `/users/{userId}`                                   | Global user reads           |
| `GET`    | `/guilds/{guildId}/members`                         | A specific member page      |
| `GET`    | `/guilds/{guildId}/bans`                            | A specific ban page         |
| `GET`    | `/channels/{channelId}/messages`                    | A specific history page     |

`path` must be a bare path with no query, version prefix, wildcard, or trailing
slash. It selects the exact Channel, Channel/Message, or Guild/User/Role IDs, so
unrelated requests cannot consume the fault. The Channel must belong to an existing Guild,
or the Guild must exist (`404` otherwise). The target Message/User/Role does not
need to exist yet, allowing prearming before message injection. Existing
Channel/Guild `POST`/`DELETE`/`PUT`/`PATCH` faults, except Guild channel creation
and Channel editing below, apply to any authenticated caller issuing that exact
request, regardless of token or body.

Channel editing (`PATCH /channels/{channelId}`) derives its Guild and registered
owning Bot from the **existing Channel**. Do not supply `guild_id`, `query`, or
`recipient_id`; these fields return `400`. The selector requires a concrete
numeric Channel ID of 1–20 digits, kept as an exact string without rounding or
normalizing leading zeros. Unknown Channels, DMs/group DMs (types 1/3), and
threads (types 10/11/12) return `404` when arming. Only existing non-thread Guild
Channels are supported, including shop text and category channels. There is no
global/private-channel scope for this selector.

For example, the DSC-1002 consumer Harness can arm a shop edit failure before
triggering its command:

```json
{
  "method": "PATCH",
  "path": "/channels/1513052391153471489",
  "status": 403,
  "code": 50013,
  "message": "Missing Permissions",
  "times": 1
}
```

Only that Guild's owning Bot token consumes the control. Other registered Bots,
Bearer callers, other Channels/Guilds, and other methods run their ordinary
routes without consuming it. Unregistered callers retain native `401` behavior.
The request body is not a selector: a selected attempt fails before body
validation, any channel mutation, or `CHANNEL_UPDATE`. The previous name,
parent, topic, position, permissions and voice/channel settings stay intact.
Every retry consumes one attempt, across `/api/v10`, `/api`, and bare prefixes;
request query parameters are ignored. An active control for the same exact
method/path returns `409`, including when switching failure modes. Exhaustion
allows rearming and retains the old control's `remaining`/`consumed` evidence
independently of the failed native operation. Cancellation removes that history.

All explicit modes (`rate_limit`, `delay`, `disconnect`) use the existing bounds,
TTL and outcome counters below. Expiry or cancellation of a delayed attempt
never resumes the native edit. Channel/Guild deletion, setup deletion, and
global or owning-token reset remove both active and exhausted controls. Moving
the Channel to another Guild or reassigning its Guild's owning token invalidates
the old control. Legacy faults on this new selector also bind the original
owner; older selectors keep their existing behavior.
Mode-omitted controls retain their remaining attempts across graceful shutdown
and restart with a persistent database; shutdown disarms only explicit modes.

After exhaustion/removal/expiry, the native route and validation run normally.
Native PATCH updates supported name/topic/NSFW/position/slowmode and voice
fields, plus validated category parents under the
[native parent contract](#native-category-parents). Omitted parents are preserved,
`null` clears them, and valid same-guild category moves persist. Invalid parents
return native `400/50035` without mutation or dispatch. Selected faults run
before this validation, including for invalid parent bodies; after exhaustion,
the same invalid request receives its native field error. Permission-overwrite
edits remain unsupported on PATCH and use the separate overwrite endpoints.
Use ordinary native calls for success-path assertions and inspect the retained
control before reset/deletion clears its evidence. `src/rest-channel-edit-faults.test.ts`
covers assembled routes plus real HTTP disconnects and Gateway dispatch barriers.

Guild channel creation faults derive their scope directly from the existing
Guild in `/guilds/{guildId}/channels`; no Channel or future Channel ID is needed.
For example, prearm a shop category creation failure before triggering the bot:

```json
{
  "method": "POST",
  "path": "/guilds/222222222222222222/channels",
  "status": 403,
  "code": 50013,
  "message": "Missing Permissions",
  "times": 1
}
```

This selector applies only to the registered Bot owning that Guild
(`guilds.bot_token`), including when `mode` is omitted. Other Bots, Bearer
callers, methods, paths, and Guilds use the ordinary native route without
consuming the control. Native requests may use `/api/v10`, `/api`, or bare
paths; the control's path must remain bare. IDs are exact 1–20 digit strings,
without numeric coercion. Optional `guild_id` must exactly equal the path's Guild
ID (`400` for a foreign/malformed scope); a nonexistent Guild returns `404`.
`recipient_id` and `query` are unsupported (`400`). Control endpoints retain
their existing auth-exempt test API contract; the Guild selects the consumer,
not an authorization requirement for arming the control.

One active control per exact method/path is allowed (`409` for another, including
across modes); different Guilds can be armed independently. It matches every
creation body in the selected Guild, including text, voice, and category
channels, before native body validation. There is no name, type, or parent
selector. Serialize scenarios sharing a Bot/Guild, or use separate Guilds.
Every selected failure creates **no Channel and no `CHANNEL_CREATE`**.
`rate_limit`, `delay`, and real-socket `disconnect` use the existing bounds,
expiry, counters, and cancellation semantics below. A delay never resumes
creation, even after expiry/removal/reset. Retries after exhaustion or removal
reach normal validation and return native `201` on valid input, persisting a
Channel and dispatching `CHANNEL_CREATE` once per successful creation.

The response reports `guild_id` from the path and `channel_id: null`.
Consumption evidence remains after failures even though no native state was
created, until the control is deleted or cleaned up. Guild/setup deletion and
global or Bot-scoped reset remove active/exhausted controls and their evidence.
Explicit modes capture ownership and are invalidated on Guild reassignment;
mode-omitted controls follow the Guild's current owning Bot, as existing scoped
user/DM controls do. These failures model errors **before** mutation, not an
ambiguous failure after a successful creation. Coverage is in
`src/rest-guild-channel-create-faults.test.ts`, using full `buildApp` routes and
real HTTP/Gateway sockets.

Member role removal (`DELETE /guilds/{guildId}/members/{userId}/roles/{roleId}`)
mirrors the `PUT` role assignment selector. For example, fail the removal of a
mute role during a manual unmute, an expiry tick, or a mute-type rollback:

```json
{
  "method": "DELETE",
  "path": "/guilds/222222222222222222/members/555555555555555555/roles/777777777777777777",
  "status": 500,
  "code": 0,
  "message": "Internal Server Error",
  "times": 1
}
```

The Guild, Member, and Role IDs are concrete numeric strings of 1–20 digits
and select that exact request; other roles, members, Guilds, methods
(including `PUT` on the same path and the unsupported member kick
`DELETE /guilds/{guildId}/members/{userId}`) and paths run their ordinary
routes without consuming the control. The Guild must exist (`404` otherwise);
the Member and Role need not exist yet, so the control can be prearmed. Query
strings, wildcards, trailing slashes, and the `query` and `recipient_id` fields
are rejected with `400`, and `guild_id` is ignored in favor of the path's Guild.
Like the `PUT` selector, a mode-omitted control is consumed by any authenticated
caller issuing the exact request, while explicit `rate_limit`, `delay`, and
`disconnect` modes bind the Guild's owning Bot and use the existing bounds,
expiry, and outcome counters. One active control per exact method/path is
allowed (`409` otherwise, including across modes), and it is independent of the
`PUT` control for the same path.

Every selected failure runs before native Guild/Role/Member validation and
removes **no role assignment** and emits **no `GUILD_MEMBER_UPDATE`**. Each
retry across `/api/v10`, `/api`, and bare prefixes consumes one attempt (`times`
budget). After exhaustion, cancellation, or expiry, the request reaches the
native route and its ordinary validation. For an existing Guild, Member, and
assignable Role it returns `204`, removes the role, and dispatches
`GUILD_MEMBER_UPDATE` once; a prearmed nonexistent Role or Member still returns
the native `404`, and `@everyone` returns `400`, with no event. Consumption evidence remains inspectable after
exhaustion until the control is deleted; Guild/setup deletion and global or
Bot-scoped reset remove active and exhausted controls. Coverage is in
`src/rest-member-role-removal-faults.test.ts`, using full `buildApp` routes and
real HTTP/Gateway sockets.

To fail a message edit (including a shop category or item message refresh in
discord-bot Harness task DSC-1004), arm the exact native PATCH path:

```json
{
  "method": "PATCH",
  "path": "/channels/333333333333333333/messages/1513052391153471489",
  "status": 500,
  "code": 0,
  "message": "Internal Server Error",
  "times": 2
}
```

The Channel's owning Guild is the cleanup scope; an optional `guild_id` cannot
override it, consistently with message DELETE controls. The Message need not
exist when the control is armed. IDs are matched as exact strings without
numeric conversion. Both retries above fail before native message lookup,
authorship checks, payload validation, stored content/embed changes, or
`MESSAGE_UPDATE` dispatch. Wrong Message IDs, Channels (including another
Guild's Channels), and methods do not consume the control. Request query
parameters are ignored, and `/api/v10`, `/api`, and bare requests share its
counter. Configure only the bare path; wildcards, placeholders, query strings,
trailing slashes, nonnumeric IDs, and IDs longer than 20 digits are rejected.
Unknown Channels and Channels without a Guild return `404` at arming.

Message edits support the existing explicit `rate_limit`, `delay`, and
`disconnect` modes with the same bounds, TTL, evidence, conflicts, and cleanup
described below. Explicit modes select only the registered Bot owning the
Channel's Guild; other tokens do not consume them. Legacy edits with `mode`
omitted retain mutation-fault behavior for any authenticated caller. Use
explicit modes when token isolation is required. An active PATCH control for
the same exact path returns `409`, including across modes; DELETE and PATCH
controls for that path are independent. Each matching attempt increments
`consumed` even though the native edit never runs. Inspect counters through
`GET /_test/rest-faults/:id`, independently of the consumer's rollback.

After exhaustion, cancellation, or expiry, PATCH uses its existing native
behavior: editing another user's message returns `403` / code `50005`, an absent
or mismatched Channel/Message returns `404`, and invalid edit payloads return
validation errors. Successful edits update content/embeds/components and emit
`MESSAGE_UPDATE`. Components follow the replacement and omission semantics
described in [Message components](#message-components). A cancelled or expired
in-flight delay still returns its configured error and never resumes the edit.
Control removal, scoped/global reset, setup deletion, Guild deletion, and
Channel deletion remove edit controls and their retained history.
`src/rest-message-edit-faults.test.ts` covers the full `buildApp` contract and
real HTTP/Gateway behavior, including socket destruction for disconnect mode and
successful edits after failures.

`GET` faults apply only to the registered Bot that owns the scope's Guild
(`guilds.bot_token`). Nonowner Bots and Bearer callers run the ordinary route
without consuming the control. Guild GETs derive their scope from the path; an
optional `guild_id` must equal that path's Guild ID. Channel GETs derive the
Guild and owning Bot from the Channel; do not supply `guild_id` for these selectors. Global `/users/{userId}` GETs
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
same method/path, normalized query (for list GETs), and owning Bot returns `409`, including when another Guild of
that Bot is supplied. No all-GET or wildcard selector is supported.

DM channel creation uses the same owning-Bot and cleanup scope as global user
GETs. Set `method` to `POST`, `path` to `/users/@me/channels`, and **require** a
numeric string `guild_id` of an existing Guild. Its owning Bot is the only caller
that can consume the control, even when creating a DM for a user outside that
Guild. Optionally set `recipient_id` to an exact numeric string (1–20 digits) to
match the request body's `recipient_id`; omit it to fault every channel creation
on this route by that Bot. The recipient need not exist when arming the fault.
For example:

```json
{
  "method": "POST",
  "path": "/users/@me/channels",
  "guild_id": "222222222222222222",
  "recipient_id": "555555555555555555",
  "status": 403,
  "code": 50007,
  "message": "Cannot send messages to this user",
  "times": 1
}
```

Other Bots, nonmatching recipients, and other endpoints run normally without
consuming this fault. Matching happens before ordinary request validation; an
unnarrowed selector also matches group-DM requests on this route. A failed attempt
never creates a private channel or enters the ordinary route. DM message sends
retain their normal behavior. All existing modes (`rate_limit`, `delay`, and
`disconnect`) and their bounds, expiry, and inspection semantics apply here too.

Missing/non-numeric `guild_id`, invalid `recipient_id` (including numbers or
`null`), a `recipient_id` on any other selector, or a `query` on this selector
returns `400` with `{"message":"400: Bad Request","code":0}`. Unknown Guilds
return `404`. Active selectors for the same Bot that overlap return `409`: this
includes the same recipient across different cleanup Guilds and an unnarrowed
selector overlapping any recipient selector. Different recipients and different
Bots may have independent controls. After exhaustion or cancellation, the
selector can be armed again. Guild deletion, setup deletion, global reset, and
`POST /_test/reset` with the owning Bot's `token` remove both active and exhausted
DM controls and their consumption history, exactly like global user GET faults.
The discord-bot Harness's per-test `ResetGuilds` deletes the Bot's setup before
registering it again, so these Guild-linked controls are removed by the same
foreign-key cascade as global user GET faults.
Use separate Bot tokens or serialize scenarios targeting the same recipient.

`status` is an integer from `400` through `599`; `code` is a nonnegative safe
integer; `message` is a nonempty string of at most 1000 characters. `times` is an
integer from `1` through `100`, defaulting to `1`. Invalid/malformed input returns
`400`. An already active legacy fault for the same method/path returns `409`.

On a matching authenticated request, Fauxcord atomically decrements `remaining`
and increments `consumed`, then returns the chosen status with exactly
`{"message":"...","code":...}`. The ordinary route does not run: no message
creation (including attachments and polls), editing, DM channel creation, deletion, ban/purge, member update,
role assignment, or corresponding Gateway mutation event happens. Authentication runs first (`401` attempts do not count);
the normal latency and rate-limit headers still apply. After exhaustion, requests
use the ordinary REST behavior, including ordinary validation and 404 responses.
Automatic library retries count as separate attempts. The control provides the
two-field Discord error body when `mode` is omitted, including legacy status `429`.
Use the explicit `rate_limit` mode below for retry semantics.

All three request prefixes (`/api/v10`, `/api`, and bare) match the same control.
Legacy selectors (all mutations, audit logs, individual members and global users)
ignore request query parameters. In particular, an audit-log fault selects the exact Guild's GET route
regardless of `action_type`, `limit`, `user_id`, `before`, `after`, parameter
ordering, or omitted parameters. These queries neither create separate targets
nor expand the path selector to other Guilds or routes. Queries in the configured
`path` are rejected with `400`.

The three list GETs select an **exact normalized page**, including its size. Set
`query` to a JSON object alongside the bare `path`; never embed a query in `path`:

```json
{
  "method": "GET",
  "path": "/guilds/222222222222222222/members",
  "query": { "after": "555555555555555555", "limit": 1000 },
  "status": 500,
  "code": 0,
  "message": "Import page failed",
  "times": 2
}
```

Only the owning Bot's member request with this cursor and size consumes these two
attempts. The first page, another cursor or size, another Guild/Channel, and
another Bot cannot consume them. Select the cursor returned by the preceding
successful page to fail a concrete later import page. This is a cursor selector,
not an ordinal page counter or a response-content predicate.

| List GET | Allowed query keys                   | Default limit | Maximum limit |
| -------- | ------------------------------------ | ------------- | ------------- |
| Members  | `limit`, `after`                     | 1             | 1000          |
| Bans     | `limit`, `before`, `after`           | 1000          | 1000          |
| Messages | `limit`, `before`, `after`, `around` | 50            | 100           |

`query` is optional: omission or `{}` selects only the default first page, never
all pages. `limit` accepts an integer or a string of 1–4 decimal digits within
`1..maximum`. Cursors must be strings of 1–20 decimal digits, preserving exact
Snowflakes; leading zeros are removed. Members normalize omitted `after` to
`"0"`; bans/messages distinguish omitted cursors from explicit `"0"`. Omitted
limits equal explicit default limits. At most one cursor is allowed. A control
with null/array query, unknown keys, unsupported cursors, multiple cursors,
invalid values or out-of-range limits returns `400`. Supplying `query` on any
legacy selector also returns `400`; their documented query-ignoring request
behavior is preserved.

Request parameter order and URL encoding do not matter. Unrelated request query
keys are ignored. The four recognized keys (`limit`, `before`, `after`, `around`)
are validated: duplicate recognized keys, unsupported cursors, multiple cursors,
or malformed/out-of-range values bypass fault consumption and run the native
route (including its existing validation behavior). Fault matching does not
change native query parsing or clamp invalid values into a faulted page.
Distinct normalized pages may be armed concurrently. Equivalent active selectors
return `409`, including differing key order, numeric/string limits, leading zeros,
and omitted/explicit defaults. Exhaustion allows rearming with a new ID while
retaining the old counters. Creation and consumption are atomic in SQLite.

Use `GET /_test/rest-faults/:id` to observe the normalized `query`, `remaining`
and `consumed` without issuing a Bot request against the armed list route. This
control endpoint accepts inspection without authentication and never consumes the
fault. Ordinary native list data recovers after exhaustion or control deletion.

Regression coverage: `src/rest-page-faults.test.ts` exercises concrete later pages
and native data recovery for all three routes, query normalization/conflicts,
authentication and scope isolation, anonymous inspection, concurrent bounds and
reset/deletion cleanup. `src/services/rest-faults.test.ts` covers migration from
pre-query databases and persistence of page selectors/counters across reopen.
`src/rest-get-faults.test.ts` and `src/e2e-rest-failures.test.ts` preserve legacy
GET and mutation contracts.

### Channel deletion failures

For DSC-1003 channel/category removal scenarios, arm `DELETE` with the exact
bare `/channels/{channelId}` path. The channel must already exist and belong
to a guild; private channels are unsupported (`404` when arming). The control
resolves `guild_id` and the owning registered bot from the channel **before**
deletion. Keep IDs as strings, including 19–20 digit Snowflakes. There are no
wildcards or ID coercion. Do not add a `query` or `recipient_id` selector.

```json
{
  "method": "DELETE",
  "path": "/channels/1513052391153471489",
  "mode": "rate_limit",
  "retry_after": 0.25,
  "times": 2,
  "timeout_ms": 30000
}
```

The bare, `/api`, and `/api/v10` native request prefixes all consume this same
selector. `rate_limit`, `delay`, and `disconnect` follow the explicit-mode
owning-bot scope below. Mode-omitted HTTP failures retain legacy mutation
behavior across authenticated tokens. Other methods/channels/guilds do not
consume it; nonowner tokens bypass explicit controls and run the native route,
including its existing deletion behavior. Active controls for the same
method/path conflict (`409`), including across modes. Each selected attempt
consumes one count before any native transaction; native rollback cannot undo
that evidence. Exhausted controls can be inspected or rearmed while the channel
exists. Inspection and control removal use the existing REST-fault APIs.

A selected failure leaves the channel, its messages, and connected voice states
intact. It emits neither `CHANNEL_DELETE` nor voice disconnect events. Delayed
attempts never enter native deletion, even after cancellation or TTL expiry.
After exhaustion/removal/expiry, a new request follows native behavior: it
deletes the channel and messages, retains disconnected voice states with
`channel_id: null`, and publishes native `VOICE_STATE_UPDATE` disconnects before
`CHANNEL_DELETE` for occupied voice/stage channels. Category deletion retains
the existing native behavior; this control adds no new category cascade.

Successful native deletion cascades away **all** controls and retained evidence
for that channel, including the DELETE control itself (`404` on inspection).
Assert consumption **before** the successful retry. If a retry deletes the
channel while a selected delay is still waiting, lifecycle cleanup releases
that wait with its configured error; it cannot delete or dispatch a second
time. Reset, guild/setup deletion, ownership invalidation and explicit-mode TTL
retain the shared cleanup rules below. The control simulates failure before
mutation, not a lost response after successful deletion. A `disconnect` scenario
requires a real Node HTTP server, as described below.

`src/rest-channel-delete-faults.test.ts` covers full-`buildApp` routing,
validation, exact scope, conflicts, retries, rollback-independent counters,
cleanup, real HTTP transport failures, and ordered Gateway evidence.
discord-bot must update its Fauxcord pin to a commit containing this capability
and exercise its own delete/retry handler; those consumer assertions remain
downstream work.

Controls and counters are isolated per
database. `/_test/reset` clears them, and environment/Guild deletion cascades
them; Channel deletion also removes channel-delete, message-send, message-edit,
message-delete and message-page controls for
that Channel. Exhausted records remain inspectable until cleared, and a fresh control may then
be armed for the same selector.

### Rate limits and transport failures

The same endpoint, selectors, count, conflicts, inspection and deletion API also
support `mode: "rate_limit"`, `"delay"`, or `"disconnect"`. These explicit modes
capture the guild's owning Bot token for **every** method. Another Bot or Bearer
caller cannot consume them; reassigned/deleted ownership invalidates them.
Moving a Channel into another Guild through `/_test/setup` also cancels its old
explicit controls and pending waits immediately after setup commits.
Legacy mode-omitted mutation controls retain their existing cross-token behavior;
DM and Guild channel creation selectors always use their documented Bot scope.
Fault selection runs after authentication and before route permission checks or
mutation. A non-owner Bot with denied send permissions still receives its armed
failure. Once that control is exhausted, the next attempt uses the current
permissions and may return `403`; granting permissions allows a normal retry.

```json
{
  "method": "POST",
  "path": "/channels/333333333333333333/messages",
  "mode": "rate_limit",
  "retry_after": 0.25,
  "global": false,
  "times": 2,
  "timeout_ms": 30000
}
```

`rate_limit` returns HTTP `429` with `message`, numeric `retry_after` (seconds),
and boolean `global`. `retry_after` is required, finite, greater than zero and at
most 60; `global` defaults to `false`. `status`, if supplied, must be `429`.
The response uses the [Discord rate-limit format](https://docs.discord.com/developers/topics/rate-limits):
`Retry-After` rounds `retry_after` up to whole seconds, as required by
[HTTP semantics](https://www.rfc-editor.org/rfc/rfc9110.html#name-retry-after).
`X-RateLimit-Reset-After` equals the precise `retry_after`,
`X-RateLimit-Reset` is the response-time epoch in seconds plus that interval,
`X-RateLimit-Remaining` is `0`, `X-RateLimit-Limit` is `1`, and the stable bucket
is `fault-{controlId}`. Scope is `user` or `global`; only global responses include
`X-RateLimit-Global: true`. Dummy headers never overwrite these values.
`global: true` tells the client to apply its global backoff; the server still
fails only the exact selector. It does not block other routes or health/control
APIs. Each matching attempt consumes one count even if it arrives before the
advertised retry interval; this models a deterministic response sequence rather
than an elapsed-time quota.

For a client deadline failure, replace the mode and retry fields with:

```json
{
  "method": "POST",
  "path": "/channels/333333333333333333/messages",
  "mode": "delay",
  "delay_ms": 5000,
  "timeout_ms": 10000,
  "times": 1
}
```

`delay_ms` is a required integer from 1 to 60000. The selected attempt waits
before response headers, then returns an error (`504`, code `0`, message
`"Transport failure"` by default). Optional `status`/`code`/`message` use the
legacy validation rules. A client deadline shorter than `delay_ms` can abort the
real connection. The abort immediately clears the timer and listener. Further
attempts proceed normally once the count is consumed, even while earlier
attempts are still delayed; an exhausted selector can also be rearmed then.
At most 256 delayed attempts may be live per database. Further selected delays
consume their count and return their configured error immediately, recording a
canceled outcome without creating a timer.

`mode: "disconnect"` needs no retry/delay fields. It destroys the real Node HTTP
socket before any response headers; clients see a connection error, not a
fabricated HTTP status. Using an in-process `app.request` without Node bindings
instead returns `501` and records a canceled attempt. Use a real server to test
transport behavior. This mode does not simulate termination after mutation or
partial response delivery.

**Every mode fails before the ordinary route runs.** Delays always terminate
with an error or disconnect; they never resume message creation, even after
client cancellation, control deletion, reset, or scope deletion. No message,
attachment, file upload, poll or `MESSAGE_CREATE` is produced by a selected
failed attempt. A retry after exhaustion is a new ordinary request and can
persist and dispatch exactly once. These controls do not depend on channel
permission enforcement. Pagination page holds remain separate controls; when
both select a GET, the page hold runs first.

`timeout_ms` is an integer from 1 to 60000, default 30000, for explicit modes
only. Its deadline starts at arming and never extends on inspection/consumption.
Unused counts expire; a pending delay is bounded by the earlier of its delay
and this deadline. Expiry returns the configured error for a still-connected
delayed client and records cancellation. Expired controls retain evidence and
permit rearming. Null policy values and fields belonging to another mode are
invalid (`400`). Existing count limits and `404`/`409` errors still apply.

Explicit-mode responses add `expires_at` (ISO timestamp), `state`, and `outcomes`:

```json
{
  "state": "exhausted",
  "remaining": 0,
  "consumed": 1,
  "outcomes": {
    "pending": 0,
    "delayed": 1,
    "responded": 0,
    "cancelled": 0,
    "disconnected": 1
  }
}
```

`consumed` counts selected arrivals. `delayed` counts attempts that entered a
wait; `pending` counts currently live waits. `responded` counts planned error
response attempts (not client acknowledgements), `disconnected` counts explicit
socket terminations and client aborts during waits, and `cancelled` counts waits
ended by lifetime/shutdown/capacity cancellation. State is `delaying` while a
wait is pending, otherwise `expired` after the deadline, `exhausted` when no
counts remain, or `armed`. Mode-omitted responses keep their legacy shape.
Inspection is uncached (`Cache-Control: no-store`) and never consumes a request.

Deletion and reset remove controls and retained evidence as before (`404` on
later inspection), releasing pending handlers with their configured
error. Invalidation is immediate within one process; another process serving the
same SQLite file observes it on a bounded 25 ms check while waits are live.
These unreferenced checks stop when the last wait finishes. Scoped reset preserves other bots' controls and delays. Channel/guild/setup
deletion cancels only the removed scope. `buildApp().shutdownRestFaults()` cancels
live waits and disarms explicit controls before HTTP drain; call it alongside
`shutdownRestPageHolds()` when embedding the app. Production and the real-server
helper do this automatically. `closeDatabase` cancels waits owned by that
connection without disarming controls used by another connection to the same
file. Timers/listeners are
removed on every completion path. Configuration, expiry and counters persist
in SQLite. Private runtime/process ownership distinguishes live waits on other
connections from abandoned waits; reopening preserves live evidence and recovers
abandoned waits as canceled outcomes. Inspection, pruning and capacity
reservation also reconcile abandoned owners on already-open surviving
connections, so a crashed process cannot permanently consume delay capacity.
Controls cannot extend their original
arming deadline across a restart.

`src/rest-transport-faults.test.ts` verifies these public contracts with real
HTTP and WebSocket clients: coherent rate-limit headers, automatic bounded
retries, native socket errors, client cancellation, concurrency, isolation,
lifetime expiry, reset/deletion/shutdown and recovery, including absence of
persistence/uploads/Gateway dispatch before failure. The retry client is a small
HTTP test client; discord-bot's library configuration and handler integration
remain downstream work.

## `POST /_test/closed-dms` — Close a human user's DMs to one bot

Register the human with `POST /_test/users`, then install the restriction:

```json
{
  "guild_id": "222222222222222222",
  "user_id": "444444444444444444"
}
```

Both fields are required nonzero Snowflake strings (1–20 digits, no leading
zeros). Extra fields are rejected. The guild must exist and belong to a bot
setup, and the user must exist and be human; guild membership is not required.
Invalid bodies (including malformed JSON and bot recipients) return HTTP `400`
with Discord's `Invalid Form Body` / `50035` field errors. Unknown guilds/users
return HTTP `404` with `10004` / `10013` respectively.

Returns HTTP `201`:

```json
{
  "id": "<control UUID>",
  "guild_id": "222222222222222222",
  "bot_id": "111111111111111111",
  "user_id": "444444444444444444"
}
```

Repeated creation for the same guild/user pair returns the same control and
`201`. The guild selects its exact owning bot setup token and provides cleanup
scope, as with global user GET REST faults. The restriction applies to that
bot's 1:1 DMs with this user, including channels created before the fixture.
`POST /users/@me/channels` still succeeds and reuses the DM normally. Every
`POST /channels/{dmChannelId}/messages` while the fixture is active returns
HTTP `403` with `{"message":"Cannot send messages to this user","code":50007}`.
It stores no message, embeds or attachments and dispatches no `MESSAGE_CREATE`.
Other users, bot setup tokens, guild channels and group DMs are unaffected.

The restriction remains active until removed or cleaned up; it has no attempt
counter, expiry or asynchronous wait. A send already persisted before creation
is unaffected. `POST /_test/reset` clears all restrictions, or only those owned
by the supplied `token`. `DELETE /_test/setup/:token`, deletion of the cleanup
guild or user, and reassignment of the guild to another setup also remove it.
Restrictions for other bots survive scoped cleanup. If you install multiple
controls for the same bot/user under different guilds, all must be removed to
restore delivery.

## `GET /_test/closed-dms/:id` — Inspect a closed-DM restriction

Returns HTTP `200` with the creation response and `Cache-Control: no-store`.
An unknown or cleaned-up control returns HTTP `404` / code `0`.

## `DELETE /_test/closed-dms/:id` — Reopen DMs

Returns HTTP `204` when removed; unknown/already removed controls return HTTP
`404` / code `0`, matching REST-fault removal. Delivery resumes immediately
using the same DM channel unless another restriction still covers the pair.

## `GET /_test/dm-channels` — Look up a bot↔human DM without creating it

Harness use case: a test needs the DM channel between the bot under test and a
human (`DMChannel(userID)`) to read what the bot sent and to send a DM to the
bot. Calling `POST /users/@me/channels` with the bot token for this would create
the channel before the bot does and would consume REST faults armed on that
path. These controls need no bot token and are exempt from authentication, like
the other `/_test` endpoints.

```bash
curl "http://localhost:3000/_test/dm-channels?guild_id=222222222222222222&user_id=444444444444444444"
```

Both query parameters follow the closed-DM rules: required nonzero Snowflake
strings (1–20 digits, no leading zeros), no repeated or unknown parameters.
`guild_id` selects the exact owning bot setup token, and so the bot user, as with
closed-DM fixtures; guild membership of the human is not required. Responses
always carry `Cache-Control: no-store`.

| Status | Body                                                                                           |
| ------ | ---------------------------------------------------------------------------------------------- |
| `200`  | The existing DM channel object, the same shape `POST /users/@me/channels` returns (`type: 1`). |
| `404`  | `{"message":"Unknown Channel","code":10003}` — the bot has not opened a DM with this human.    |
| `404`  | `10004` Unknown Guild / `10013` Unknown User.                                                  |
| `400`  | `Invalid Form Body` / `50035` for malformed parameters or a bot `user_id`.                     |

The lookup never creates a channel, never consumes or is blocked by a REST fault,
and emits no Gateway event.

## `POST /_test/dm-channels` — Open the DM as the human

Models a human opening a DM with the bot. Body, as for closed-DM fixtures:

```json
{
  "guild_id": "222222222222222222",
  "user_id": "444444444444444444"
}
```

Validation matches `POST /_test/closed-dms`: both fields are required nonzero
Snowflake strings, extra fields and malformed JSON are rejected with `400` /
`50035`, bot recipients are rejected with `400` / `50035` on `user_id`, and
unknown guilds/users return `404` / `10004` / `10013`.

Returns the DM channel object. HTTP `201` when this call created the channel and
`200` when the 1:1 DM already existed (idempotent). The control shares storage
and lookup rules with `POST /users/@me/channels`, so a later bot call returns the
same channel (and a channel the bot opened first is returned here with `200`).
Like the real endpoint, channels are keyed by bot user ID: two setup tokens that
share a bot user ID share the DM. Different bot users never do. It does not
consume REST faults armed on `POST /users/@me/channels`, and emits no Gateway
event. As with real-path DMs, the channel is not removed by `/_test/reset`.

Typical Harness flow:

1. `POST /_test/dm-channels` (or `GET`, once the bot has replied) to get `id`.
2. `POST /_test/channels/{id}/messages` with the human as `author` to DM the bot.
3. `GET /_test/messages/{id}` or the bot's own message endpoints to read replies.

Injecting into a DM or group-DM channel (see
[`POST /_test/channels/:channelId/messages`](#post-_testchannelschannelidmessages--inject-a-message-from-a-specific-user))
requires the `author` to be a recipient of that channel. Otherwise the request
returns HTTP `403` with `{"message":"Missing Access","code":50001}`, stores no
message or attachment, and emits no event. The recipient's message is stored and
produces the ordinary `MESSAGE_CREATE`.

## `GET /_test/rest-faults/:id` — Inspect consumption

Returns the control object, including `remaining` and `consumed`, or `404` for
an unknown/cleared control. Assert `consumed === 1` and `remaining === 0` to prove
a one-shot fault was exercised. Inspection does not consume a fault.

## `DELETE /_test/rest-faults/:id` — Cancel and remove a control

Returns `204` when removed, or `404` if unknown. Removes both the active failure
and its history; subsequent requests run normally. Pending transport delays
finish with their configured error and never enter the ordinary route.

---

## Message embed validation

The ordinary channel message create/edit routes, webhook execution/followups,
webhook message edits (including `@original`), and type-4 interaction callbacks
share embed text validation. This lets nickname-log tests exercise actual invalid
embed requests without configuring a REST fault. No new control API is needed.
Human message injection/edit routes model content only and retain their existing
behavior.

Following [Discord's embed limits](https://docs.discord.com/developers/resources/message#embed-limits),
limits are inclusive and exclude leading/trailing whitespace in each text value:

| Property                                               | Maximum         |
| ------------------------------------------------------ | --------------- |
| Embeds per message                                     | 10              |
| `title`                                                | 256 characters  |
| `description`                                          | 4096 characters |
| Fields per embed                                       | 25              |
| `fields[].name`                                        | 256 characters  |
| `fields[].value`                                       | 1024 characters |
| `footer.text`                                          | 2048 characters |
| `author.name`                                          | 256 characters  |
| All of the above text across all embeds in one message | 6000 characters |

Characters are Unicode code points, matching the official OpenAPI request
schema's JSON Schema `maxLength` semantics. An astral emoji counts as one;
combining marks count separately. URLs, message content, and other embed
properties do not contribute to the 6000-character text budget. Counting excludes
surrounding whitespace; validation does not rewrite stored text.

The [official `RichEmbedField` request schema](https://github.com/discord/discord-api-spec/blob/main/specs/openapi.json)
requires both `name` and `value` to be strings and specifies no `minLength`.
Empty strings and whitespace-only strings are therefore accepted; missing or
null field names/values are rejected. `inline` may be omitted, null, or boolean.
Optional title/description, author/footer objects and their text properties,
and the fields collection may be omitted or null. An empty author/footer object
is accepted by the request schema. Embed/field entries must be objects;
malformed collections, objects, and text values return deterministic HTTP `400`
with code `50035` (`Invalid Form Body`) and errors at the affected field paths.
These text checks do not add URL, timestamp, color, or media validation.

Omitted `embeds` leaves embeds unchanged on edit. `embeds: null` and `embeds: []`
clear them; on creation both are empty collections (including discordgo's
`embeds: null` compatibility). Normal empty-message rules still apply.
Rejected requests persist no message/embed changes and emit no `MESSAGE_CREATE`
or `MESSAGE_UPDATE`; rejected callbacks do not acknowledge the interaction.
The validator has no retained state, so requests, channels, and reset cycles
cannot share a character budget.

---

## Message components

Fauxcord persists classic action rows of buttons on messages. For example,
shop messages can carry Buy and Return controls:

```json
{
  "content": "Shop item 42",
  "components": [
    {
      "type": 1,
      "components": [
        {
          "type": 2,
          "style": 1,
          "label": "Buy",
          "custom_id": "shop_item_buy_42"
        },
        {
          "type": 2,
          "style": 4,
          "label": "Return",
          "custom_id": "shop_item_return_42"
        }
      ]
    }
  ]
}
```

`POST /channels/:channelId/messages` stores the components. A `PATCH` containing
`components` replaces the entire collection; send a row with just Buy to remove
Return. Omit `components` to keep the stored collection. `components: []` or
`components: null` clears it. Creation without components defaults to `[]`.
Components alone can make a nonempty message, and component-only edits update
`edited_timestamp`.

The create/edit responses, single-message reads, all message history pages
(`before`, `after`, `around`, and `limit`), both pin APIs, and Gateway
`MESSAGE_CREATE`/`MESSAGE_UPDATE` contain the same persisted `components` array.
`GET /_test/messages/:channelId` also includes it on every message. Supported
button fields retain their values and order; legacy row/button `id` is normalized
to `0`, optional null fields and unknown fields are omitted. Defaults such as
`disabled: false` are not inserted when omitted. Custom emoji IDs/names are
snapshots, independent of the emoji catalog. Existing databases gain an empty
collection for older messages; message deletion and existing reset operations
remove components with their message.

Following [Discord's component reference](https://docs.discord.com/developers/components/reference),
the supported subset validates:

- At most 5 top-level action rows (`type: 1`), each with 1–5 buttons (`type: 2`).
- Integer styles 1–4 require a nonempty `custom_id` of 1–100 Unicode code points
  and prohibit `url` and `sku_id`. Each `custom_id` must be unique across the
  entire message, including disabled buttons and different rows.
- Link style 5 requires an absolute `http:`, `https:`, or `discord:` URL of at
  most 512 code points and prohibits `custom_id` and `sku_id`.
- Every button needs a nonempty label or an emoji. Labels have at most 80 code
  points; optional `disabled` must be boolean. Optional null button fields count
  as absent. Identifiers and labels are not trimmed.
- Emoji must be an object with a nonempty name (at most 32 code points) or a
  positive Snowflake string `id` (up to 20 digits). `id: null` represents a
  Unicode emoji; optional `animated` must be boolean. Fauxcord validates shape,
  without checking Unicode emoji membership or access to live custom emojis.

Malformed collections/entries, invalid fields, duplicate IDs, and unsupported
components return HTTP `400`, code `50035`, `message: "Invalid Form Body"`, with
`errors` keyed by affected dotted field paths and `_errors` arrays, matching the
other Fauxcord validators. Validation runs before message mutation or dispatch.

Deliberate fidelity gaps: select menus (types 3/5/6/7/8), premium buttons
(style 6), modal/text inputs, components v2/layout/content types, and nonzero
numeric component IDs are unsupported and return the same `400`/`50035` shape.
The `IS_COMPONENTS_V2` flag (`32768`) is rejected even with an empty component
array. There is no v2 ID generation, rendering, emoji availability check, or
click simulation.

Type-4 interaction responses, interaction followups, webhook execution, and
webhook message edits (including `@original`) share component storage and
validation. Deferred callbacks and existing acknowledgement-only callback types
retain their existing semantics. Human-message injection/edit and startup seed
fixtures retain their existing content-focused contracts; their components
start empty and content-only edits preserve any stored components. No new
interaction semantics or fixture fields are introduced.

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
Every inspected message includes `components` (an empty array when absent).
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

## `PATCH /_test/users/:userId` — Prepare a human global name silently

Updates only `global_name` on an **existing non-bot user**. Like other test
controls, this endpoint requires no Authorization header. It returns `200` with
the native user object (the same shape as `GET /users/:userId`).

```bash
curl -X PATCH http://localhost:3000/_test/users/555555555555555555 \
  -H "Content-Type: application/json" \
  -d '{"global_name":"New Display Name"}'
```

`global_name` accepts a string, stored exactly as supplied (including an empty
string), or explicit `null` to clear it. Omission (`{}`) preserves the current
value and returns the existing user. An empty body, malformed JSON, non-object
JSON, unsupported fields (including `username`, `avatar`, and `bot`), or a
non-string/non-null name returns `400` without any mutation. Field validation
errors use code `50035`; malformed bodies use code `0`. Unknown users return
`404` / `10013`; bots return `400` / `0` with `User must not be a bot`, even for
`{}`. No user is created or converted, and registration still returns `409`
for an existing ID.

The fixture changes the database's global user profile, shared by every Guild
membership of that human in this Fauxcord instance. It preserves the user ID,
`bot: false`, username, discriminator, avatar, memberships, roles, nicknames,
member dates, and all unrelated state. Other users and separate Fauxcord
instances are unaffected. `PATCH /users/@me` retains its bot-only behavior.

**No Gateway events are emitted by this fixture.** Existing client cache inputs
and captured historical envelopes keep their old profile. For a display-name
change scenario, first register and join the human, let the consuming client
receive its initial `GUILD_CREATE` or a native member update, then call this
fixture. Follow it with authenticated `PATCH /guilds/:guildId/members/:userId`
containing `{"nick":"New nickname"}`. The native `GUILD_MEMBER_UPDATE` contains
that same human ID, the prepared `user.global_name`, and the new nickname,
subject to ordinary Guild/Bot/session scope and intents. Explicit null clearing
works through the same sequence. This lets a client's prior member snapshot
hold the old global name until the native update arrives. Socket delivery alone
does not prove that the consuming bot's callback has completed.

---

## `PATCH /_test/guilds/:guildId/members/:userId` — Prepare member dates

Silently sets `joined_at` and/or `premium_since` on an **existing** Guild
membership, including Bot members. No Authorization header is required. Run
this after `/_test/setup` (for the bot or human owner) or joining a test user,
before starting the Bot or connecting it to the Gateway:

```bash
curl -X PATCH http://localhost:3000/_test/guilds/222222222222222222/members/555555555555555555 \
  -H "Content-Type: application/json" \
  -d '{"joined_at":"2019-01-02T03:04:05Z","premium_since":"2020-02-29T14:00:00.123+02:00"}'
```

The body must be a JSON object. These are its only supported fields:

| Field           | Omitted                                              | `null`                       | Timestamp string           |
| --------------- | ---------------------------------------------------- | ---------------------------- | -------------------------- |
| `joined_at`     | Preserve the stored join date.                       | Rejected.                    | Set the stored join date.  |
| `premium_since` | Preserve the stored boost date (defaults to `null`). | Clear the stored boost date. | Set the stored boost date. |

`{}` preserves both dates. Either field can be supplied alone, or both in one
atomic request. Use a valid calendar date and `YYYY-MM-DDTHH:mm:ss`, optionally
followed by fractional seconds, then `Z` or a numeric `±HH:mm` timezone.
`premium_since` accepts 1–6 fractional digits. Dates normalize to UTC with six
fractional digits and `+00:00`; precision beyond milliseconds is truncated. The
example returns `2019-01-02T03:04:05.000000+00:00` and
`2020-02-29T12:00:00.123000+00:00`, respectively. Input calendar dates and
normalized UTC years must be valid four-digit years. There is no constraint
relative to the current time, allowing historical or future fixtures.

**Response**: `200 OK` with the stored Guild member object. The same dates
appear in individual member GETs, paginated member lists, the scoped OAuth
`GET /users/@me/guilds/:guildId/member`, and the next `GUILD_CREATE.members`.
Dates persist across server restarts. The operation changes only the requested
dates for that Guild/user pair, preserving profile, nickname, Roles and all
other member state. It does not create a user or membership, alter Guild boost
counts/tier, or emit Gateway events or event-bus activity. Ordinary member
updates preserve fixture dates. Connected clients receive no cache update;
fetch the member again or reconnect to read the prepared state.

Member reads interpret legacy SQLite `YYYY-MM-DD HH:mm:ss` timestamps as UTC
on every host timezone, while respecting explicitly zoned fixture timestamps.

**Errors** (no state changes or events): `404` / `10004` for an unknown Guild;
`404` / `10007` for an unknown membership (including unknown users or users only
in another Guild); `400` / `0` for malformed JSON, a missing body or a non-object
body; `400` / `50035` with field errors for unsupported fields, invalid types,
invalid calendar dates, timestamps without a timezone, UTC year overflow, or
`joined_at: null`. **All fields are validated before any writes**, so an invalid
field leaves both dates and all other state unchanged.

The member POST keeps its generated current join date and live add event;
ordinary authenticated member PATCH does not accept `joined_at`. Deleting and
rejoining a prepared member generates a fresh join date through the existing
live path. The top-level `GUILD_CREATE.joined_at` remains the mock's guild
availability timestamp; this control prepares `GUILD_CREATE.members`.

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
`GUILD_MEMBER_REMOVE` through the existing Gateway path (preceded by a voice
disconnect when the member was connected; see
[Member removal disconnects voice](#member-removal-disconnects-voice)). The user profile remains
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
| `content`             | —        | Message content, up to 2,000 characters. Optional when valid stickers or attachments are supplied.                                |
| `attachments`         | —        | Up to 10 byte-preserving base64 file fixtures; see below.                                                                         |
| `sticker_ids`         | —        | Up to three distinct existing sticker IDs as snowflake strings. Omitted, `null`, or `[]` means no stickers.                       |
| `author.id`           | ✅       | ID of a user already registered via `POST /_test/users` (or any other existing user). Returns `404` if unregistered.              |
| `id`                  | —        | Explicit numeric Message ID (1–20 digits), otherwise generated. An existing Message ID returns `409` without mutations or events. |
| `remove_after_create` | —        | Boolean, default `false`. Atomically remove after capturing its create snapshot; queue create then delete after commit.           |

In a DM or group-DM channel the `author` must be a recipient; otherwise the
request returns `403` with `{"message":"Missing Access","code":50001}` and
stores nothing (see [`POST /_test/dm-channels`](#post-_testdm-channels--open-the-dm-as-the-human)).

**File fixtures**

Supply `attachments` as an array of up to 10 objects. Each object has a
`filename`, `content_type` (MIME type), and `data` containing canonical padded
base64 of the original file bytes. No URLs are fetched. Each decoded file may
be at most 25 MiB, matching Fauxcord's existing multipart upload limit. Empty
files are allowed. Omit `content` or use `""` for an attachment-only message.
Malformed base64, invalid MIME types, path separators, control characters,
empty names, and filenames over 255 UTF-8 bytes return `400` without creating
a message or emitting events. Filenames with spaces, Unicode, `#`, and `?` are
preserved. Multiple files may share a filename; their returned URLs are unique.

```json
{
  "author": { "id": "555555555555555555" },
  "content": "Original evidence",
  "attachments": [
    {
      "filename": "proof.txt",
      "content_type": "text/plain",
      "data": "aGVsbG8="
    },
    {
      "filename": "raw.bin",
      "content_type": "application/octet-stream",
      "data": "AP8="
    }
  ]
}
```

The `201` response and the **first native `MESSAGE_CREATE`** both contain all
persisted attachment metadata, including `id`, `filename`, `size`,
`content_type`, `url`, and `proxy_url`. The same guarantee applies to ordinary
bot multipart sends (`payload_json` plus `files[0]` through `files[9]`). Files
are saved before the message is published; storage or database failures leave
no visible message, related rows, uploaded files, or create events. A storage
failure returns `500` instead of silently returning an attachmentless message.

Original attachment URLs remain downloadable after ordinary single/bulk
message deletion and `remove_after_create`, so deletion logs can fetch the
bytes and re-upload them through the bot's normal multipart REST API. The MIME
type is retained even when the filename extension differs. Retention is bounded
by the test lifecycle: `/_test/reset` without a token removes all retained
uploads and download metadata, including deleted human-message files. A reset
with a token removes only that bot's uploads, even if their messages were
already deleted; human and other bots' uploads stay intact, matching existing
message reset scope. `DELETE /_test/setup/:token` also clears uploads in the
removed channels. Use a full reset or discard the emulator's database and upload
directory between test suites; there is no time-based expiry. Reset does not
cancel HTTP requests already in flight.

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
supported. Empty content with neither stickers nor attachments still fails.
Attachments and stickers can be combined in one human fixture or bot multipart
send; the initial create snapshot contains both fields.

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
`"remove_after_create": true` and do not arm a DELETE fault. The service captures
the full create snapshot and removes the stored message
in one transaction. After that transaction commits, it synchronously queues
`MESSAGE_CREATE` followed by `MESSAGE_DELETE` before yielding to another HTTP
request. A creation or removal failure rolls back the message, stickers, and
attachments without emitting either event. Connected clients with the Guild
Messages intent see
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

## `POST /_test/channels/:channelId/messages/:messageId/reactions` — Add a human reaction

Adds a persisted normal or burst (super) reaction as an existing registered
human. This test
control requires no authentication, like the other `/_test/*` routes. Register
users with `POST /_test/users`, then join each reactor through
`POST /_test/guilds/:guildId/members/:userId` before adding reactions. The source
message must already exist in a guild text (`type: 0`) or announcement
(`type: 5`) channel; it may be authored by a bot, human, or webhook.

```bash
curl -X POST http://localhost:3000/_test/channels/333333333333333333/messages/MESSAGE_ID/reactions \
  -H "Content-Type: application/json" \
  -d '{"user_id": "555555555555555555", "emoji": "🐝"}'
```

The JSON object requires a nonempty string `user_id` and an `emoji` string
containing either exactly one Unicode RGI emoji sequence supported by the pinned
Node runtime (for example `🐝`, `👍🏽`, `👩‍💻`, `🇵🇱`, `1️⃣`, and `❤️`) or a
custom guild emoji in Discord's reaction form `name:id`, or animated
`a:name:id` (for example `party:123456789012345678`). Send the literal value in
JSON; do not URL-encode it. Other fields are ignored. Bare IDs, `<:name:id>`
mention syntax, arbitrary text, and multiple emoji in one string are
unsupported. DMs, group DMs, threads, voice, forum, and other channel types are
outside this producer's scope. Ephemeral messages are excluded.

| Field          | Required | Description                                                                                                            |
| -------------- | -------- | ---------------------------------------------------------------------------------------------------------------------- |
| `user_id`      | ✓        | Registered non-bot member of the channel's guild.                                                                      |
| `emoji`        | ✓        | One Unicode RGI emoji sequence, or a custom `name:id` / `a:name:id` emoji of the channel's guild.                      |
| `burst`        | —        | Boolean, default `false`. `true` adds a burst (super) reaction (`type: 1`) instead of a normal one.                    |
| `burst_colors` | —        | Only with `"burst": true`. Array of `"#rrggbb"` strings echoed in the add event and the message summary. Default `[]`. |

```bash
# A live human super reaction
curl -X POST http://localhost:3000/_test/channels/333333333333333333/messages/MESSAGE_ID/reactions \
  -H "Content-Type: application/json" \
  -d '{"user_id": "555555555555555555", "emoji": "🐝", "burst": true, "burst_colors": ["#ffcc4d"]}'
```

A custom emoji must exist in the source channel's guild; otherwise the request
fails with `400 Unknown Emoji` (code `10014`), as Discord does. Only the ID
identifies the emoji: the `name` part and the `a:` prefix may be stale or
different (for example after a rename), and the payload always uses the
emoji's current name and animated flag. See
[Custom guild emoji reactions](#custom-guild-emoji-reactions) for seeding,
renaming and the native REST routes. Custom emoji support normal and burst
reactions alike.

Returns `204 No Content`, including repeated adds of the same
user/message/emoji/type. Normal and burst memberships are separate: the
reaction service inserts one row per unique message/user/emoji/type tuple, so
one human may hold a normal and a burst reaction of the same emoji at once. A
duplicate adds no count, emits no event and keeps the original colors.
Distinct humans and distinct emoji have independent rows. The control never
registers a bot, changes a user's profile or `bot: false`,
creates membership, or changes roles, nicknames, or membership dates. Membership
in the source guild is required; membership in another guild does not qualify.
This fixture does not evaluate channel permission overwrites or user eligibility
rules implemented by your bot.

Ordinary `GET /channels/:channelId/messages/:messageId/reactions/:emoji` reads
expose the same registered human with `bot: false`: `type=0` (or omitted) lists
normal members and `type=1` lists burst members, each with `limit` and `after`
pagination in numeric user-ID order (shorter snowflakes first). Other `type` values return `400 Invalid Form Body` (code `50035`).
Single-message and message history reads include per-emoji summaries: `count`
is normal plus burst, `count_details` is `{ "normal": n, "burst": b }`, and
`burst_colors` holds the colors of the emoji's earliest remaining burst
reaction (`[]` without bursts). `me_burst` is always `false` because the
requester is a bot and only humans can hold burst reactions; `me` keeps its
existing behavior. These REST routes still require normal bot authentication and
work under `/api/v10`, `/api`, and bare paths. The ordinary `PUT .../reactions/:emoji/@me` continues to react as its
actual authenticated bot; no human token or impersonation mode is introduced.

Connect the guild's setup bot and wait for Gateway READY before adding reactions.
Sessions need the Guild Message Reactions intent (`1024`). Each new row emits
native `MESSAGE_REACTION_ADD` through the existing bus, dispatch, capture and
resume pipeline, containing `user_id`, `guild_id`, `channel_id`, `message_id`,
`emoji: {"id": null, "name": "🐝"}` (custom:
`{"id": "123456789012345678", "name": "party", "animated": false}`), the
existing reactor's full `member` data, `message_author_id`, `burst`, `type`, and
`burst_colors`. A normal add has `burst: false`, `type: 0`, and
`burst_colors: []`; a burst add has `burst: true`, `type: 1`, and the requested
`burst_colors` (default `[]`). Delivery
is limited to that guild's setup token and bot ID in the originating database,
including all matching sessions with the intent. Raw and `Bot `-prefixed IDENTIFY
tokens work. Another setup sharing the bot ID does not receive the event.
Persistence succeeds without a connected session; delivery does not wait for an
acknowledgement and is not retried as a new add when the reaction already exists.

Rejected requests produce no reaction row, membership changes or add event:

| Status / code   | Meaning                                                                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `400` / `50035` | Malformed/missing JSON object, invalid `user_id`, or invalid/unsupported `emoji`. Field details appear in `errors.user_id` / `errors.emoji`. |
| `404` / `10003` | Unknown/deleted channel.                                                                                                                     |
| `404` / `10008` | Unknown/deleted/ephemeral message, or message belongs to another channel.                                                                    |
| `404` / `10013` | Unknown user.                                                                                                                                |
| `404` / `10007` | Human is not a member of the source guild.                                                                                                   |
| `400` / `10014` | Custom emoji does not exist in the source guild.                                                                                             |
| `400` / `0`     | Actor is a bot, or channel/setup scope is unsupported.                                                                                       |
| `500` / `0`     | Reaction persistence failed; no add was emitted.                                                                                             |

`400` / `50035` also covers a non-boolean `burst` (`errors.burst`) and
`burst_colors` that is not an array of `"#rrggbb"` strings or is sent without
`"burst": true` (`errors.burst_colors`).

Validation runs before target resolution. Target resolution checks channel and
supported guild/setup scope, message, user, bot flag, membership, then custom
emoji existence. The
operation installs no pending producer and needs no fixture-specific cleanup.
Ordinary single-user removal removes only the normal membership (see below);
emoji clear and message reaction clear remove both types. Re-adding a removed
reaction produces a new add event. Reaction-clear
routes retain their current behavior and do not gain new Gateway producers.
Message/channel/guild/setup deletion cascades reaction removal. Full
`POST /_test/reset` removes all message reactions. A token reset removes reactions
only when their source message is deleted by the existing reset policy: messages
authored by that token are deleted; retained human messages and their reactions
remain. Registered human profiles survive these controls; guild memberships
survive resets and are removed with their guild.

Existing Gateway event controls can capture, hold, release and replay the native
human add. Holding affects delivery, not persistence or REST reads. Captures keep
the original human profile and member snapshot even after profile edits, reaction
removal or source-message deletion. Release/replay never recreate a reaction or
message. Default `sequence: "new"` advances the session sequence; opt-in
`sequence: "original"` uses the captured sequence under the existing policy.
Token/full reset, setup/guild deletion, session replacement/disconnect,
cancellation and expiry invalidate captures as before. A guild-scoped capture can
survive channel or message deletion while its guild/session scope remains valid.
Arm a fresh control after reset. This API supplies live fixture state for a future
Harness wrapper; it neither implements that wrapper nor guarantees bot-side
statistics or cache invalidation, which must be asserted through your bot.

### Live reactions by another bot

Bot users react through the native REST routes instead of this control. Register
an auxiliary bot at any time, including while the tested bot is connected, with
`POST /_test/setup` (`"guilds": []`), and add it to the guild with
`PUT /guilds/:guildId/members/:userId`. Its
`PUT .../reactions/:emoji/@me` and `DELETE .../reactions/:emoji/@me` (as that
bot), or the tested bot's `DELETE .../reactions/:emoji/:userId`, persist the
membership and emit native events to connected sessions with the Guild Message
Reactions intent:

- `MESSAGE_REACTION_ADD`: `user_id`, `guild_id`, `channel_id`, `message_id`,
  `emoji`, the reactor's current `member` (with `user.bot: true`),
  `message_author_id`, `burst: false`, `type: 0`, and `burst_colors: []`.
- `MESSAGE_REACTION_REMOVE`: `user_id`, `guild_id`, `channel_id`, `message_id`,
  `emoji`, `burst: false`, and `type: 0`.

Reaction-user reads list the bot with `bot: true`. Duplicate adds and removals of
absent reactions emit nothing.

### Removing burst reactions

Discord's documented `DELETE .../reactions/:emoji/@me` and
`DELETE .../reactions/:emoji/:userId` routes have no reaction-type selector, and
the docs do not say which of a user's memberships they remove (the documented
`type` default of `0` belongs to Get Reactions only). So there is no documented
way to remove only one user's burst reaction; the emoji and message clear routes
remove both types. As a mock assumption, not verified Discord behavior,
Fauxcord treats both single-user routes as removing the **normal** membership
and leaves a burst membership intact. Bots cannot super-react, so `@me` never
holds a burst reaction. Both routes keep their existing behavior, emitting
`MESSAGE_REACTION_REMOVE` with `burst: false` and `type: 0`. Use the following
control to end a human's burst reaction.

## `DELETE /_test/channels/:channelId/messages/:messageId/reactions` — Remove a human reaction

Removes a registered human's normal or burst reaction, as when the person
removes it in the client. It takes the same JSON body fields and target rules
as the add control, with one exception: a custom emoji is matched by ID and
need not still exist, so a reaction can be removed after its guild emoji was
deleted. `burst_colors` only describes an add, so here it is ignored like any
other unrecognized field:

```bash
curl -X DELETE http://localhost:3000/_test/channels/333333333333333333/messages/MESSAGE_ID/reactions \
  -H "Content-Type: application/json" \
  -d '{"user_id": "555555555555555555", "emoji": "🐝", "burst": true}'
```

`burst: true` removes the burst membership; omitted or `false` removes the
normal one. The other type is never touched. Returns `204 No Content`, also when
the human holds no such reaction. When a row is removed it emits native
`MESSAGE_REACTION_REMOVE` with `user_id`, `channel_id`, `message_id`, `guild_id`,
`emoji: {"id": null, "name": "🐝"}`, `burst` and `type` (`true`/`1` for a burst
removal). Delivery uses the same setup scope as the add control: the guild's
setup token and bot ID in the originating database, with the Guild Message
Reactions intent (`1024`). Removing an absent reaction emits nothing. Validation
and target errors match the add control's table and leave reactions unchanged;
a human who is no longer a guild member gets `404` / `10007`, and REST clears
still remove that human's rows.

Reactions have no public seed: `SEED_FILE` registers bots only. Seeding fixtures
with SQL or the test helpers stays silent, as before; only these controls and
REST routes emit reaction events.

---

## Custom guild emoji reactions

Reactions with custom guild emoji work through the human reaction producer
above and through every native reaction route. Address a custom emoji as
`name:id`, or animated `a:name:id`, URL-encoded in REST paths (for example
`party%3A123456789012345678`):

| Route | Effect |
| ----- | ------ |
| `PUT /channels/:cid/messages/:mid/reactions/:emoji/@me` | Bot adds its reaction; emits `MESSAGE_REACTION_ADD`. |
| `DELETE /channels/:cid/messages/:mid/reactions/:emoji/@me` | Bot removes its reaction; emits `MESSAGE_REACTION_REMOVE`. |
| `DELETE /channels/:cid/messages/:mid/reactions/:emoji/:userId` | Removes one user's reaction; emits `MESSAGE_REACTION_REMOVE`. |
| `GET /channels/:cid/messages/:mid/reactions/:emoji` | Lists reaction users (`limit`, `after`, `type` as for Unicode). |
| `DELETE /channels/:cid/messages/:mid/reactions/:emoji` | Clears the emoji; emits `MESSAGE_REACTION_REMOVE_EMOJI`. |

**Identity.** A custom reaction is identified by the emoji ID alone. The name
and `a:` prefix in a request are not compared, so `party:ID`, `fiesta:ID` and
`a:party:ID` all address the same reaction, count once per user, and appear as
one entry in message `reactions`. This matches bots that key custom reactions
by ID so identity survives renames. Unicode emoji keep their exact-string
behavior; only `name:id` / `a:name:id` with a numeric ID is custom, so a string
such as `custom:foo` stays an exact Unicode-style key. Reactions persisted by older Fauxcord versions under `name:id` are
migrated to ID identity at startup.

**Emoji objects.** Gateway reaction events and message `reactions[].emoji`
carry `{ "id": "<id>", "name": "<current name>", "animated": <bool> }` for
custom emoji, using the guild emoji's current name and animated flag. Unicode
emoji stay `{ "id": null, "name": "🐝" }`. If the guild emoji has been deleted,
message `reactions[].emoji.name` is `null` (Discord's "emoji data unavailable"
form), and removal/clear events fall back to the name and `a:` prefix from the
request path.

**Unknown emoji.** Adding a custom reaction fails with `400 Unknown Emoji`
(code `10014`) and no state or event when the emoji does not exist. The human
producer requires the emoji in the message's guild. `PUT .../@me` accepts an
emoji from any guild owned by the bot's setup token or in which the bot user is
a member (only existence is checked for unregistered tokens with
`DISABLE_AUTH`). Removal, listing and clear routes do not check existence, so
reactions of a deleted emoji can still be cleaned up.

**Seeding emoji.** Create guild emoji with the native
`POST /guilds/:guildId/emojis` (`{"name": "party", "image": "data:image/png;base64,..."}`).
Creation is a silent seed: it emits no Gateway event. An `image` data URI with
media type `image/gif` (compared case-insensitively) creates an animated emoji
(`animated: true`). Use the returned
`id` in reaction requests.

**Renaming emoji.** `PATCH /guilds/:guildId/emojis/:emojiId` with
`{"name": "fiesta"}` keeps the ID, so existing reactions are unaffected, and
subsequent reaction events, reaction-user reads and message `reactions` use the
new name. A modify that changes the name or roles emits native `GUILD_EMOJIS_UPDATE`
(`{"guild_id": "...", "emojis": [<full guild emoji list>]}`) to the guild
setup's bot sessions that have the Guild Expressions intent (`8`). A no-op
modify, emoji creation and deletion emit nothing.

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
`404` `{"message": "Unknown Guild", "code": 10004}` when `guild_id` is not an
existing guild the application's bot is still in (for example after the bot
left or was removed; the surviving guild gets no interaction),
and `404` `{"message": "Unknown Channel", "code": 10003}` when `channel_id` does
not exist, belongs to a different guild than `guild_id`, or belongs to a guild
the bot left or was removed from.

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

## `GET /_mock/attachments/...` — Download an attachment

Message and application attachment responses contain a public `url` and `proxy_url` under this path. Fetch the returned URL without an Authorization header to verify the uploaded bytes in your test.

```bash
curl http://localhost:3000/_mock/attachments/333333333333333333/1513052391153471489/proof.txt
```

New message uploads use `/_mock/attachments/:channelId/:messageId/:attachmentId/:filename`; existing three-component URLs remain supported. Always fetch the returned URL rather than constructing one. The response uses the uploaded file's content type and returns the original bytes, including after message deletion until reset/setup cleanup. An attachment that does not exist returns `404` with Fauxcord's standard error response.

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
    "MESSAGE_CREATE",
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
is pinned to the resolved session and socket and never follows a replacement. The explicit `disconnect` action below is the
only exception: it can retain this exact session through one controlled RESUME.
After an ordinary disconnect/replacement, create a fresh control; the returned ID identifies
the newly resolved session.

`events` is a nonempty, unique subset of `VOICE_STATE_UPDATE`, `MESSAGE_CREATE`,
`MESSAGE_DELETE`,
`MESSAGE_DELETE_BULK`, `MESSAGE_REACTION_ADD`, `MESSAGE_REACTION_REMOVE`,
`MESSAGE_REACTION_REMOVE_ALL`, `MESSAGE_REACTION_REMOVE_EMOJI`, and
`GUILD_MEMBER_UPDATE`. Only events
that the native producer actually emits are captured. Message creation (including
human messages via `POST /_test/channels/:channelId/messages`), single deletion,
native bulk deletion through the REST endpoint below, reaction addition (including
human additions through the control above), single reaction removal, and both
reaction-clear DELETE endpoints have native producers.

For voice, arm the same control API with
`"events": ["VOICE_STATE_UPDATE"]` and drive real transitions through
`PATCH /_test/guilds/:guildId/voice-states/:userId` (or the existing stage PATCH
routes, or `DELETE /channels/:channelId` of an occupied voice/stage channel).
The selected session must have the Guild Voice States intent; filtering
happens before capture. Silent `emit: false` fixtures, no-op writes, rejected
requests, and changes to an already disconnected state produce no event to
capture. Kicks and bans of a connected member also produce a capturable
disconnect (see [Member removal disconnects voice](#member-removal-disconnects-voice));
the following `GUILD_MEMBER_REMOVE` is not held by a voice capture.
Voice dispatches follow the guild's registered bot, exact setup token,
and app database; a capture never holds another session's delivery.

Without a selector, a voice capture includes all users and voice/stage channels
in the selected guild. Inspect `envelope.d.user_id` and `channel_id` to choose
event UUIDs; disconnects have `channel_id: null`.

To capture or hold only one user's voice transitions, add `member_id` (see
[member selectors](#member-selectors) below):

```json
{
  "guild_id": "222222222222222222",
  "bot_id": "111111111111111111",
  "session_id": "SESSION_ID_FROM_READY",
  "events": ["VOICE_STATE_UPDATE"],
  "member_id": "888888888888888888",
  "hold": true
}
```

Only dispatches whose `d.user_id` equals `member_id` are captured. Other users'
voice dispatches in the same guild are not captured, not held, and are delivered
immediately with their ordinary native sequence, exactly as if no control
existed. For example, hold user A's leave while user B's join is delivered, then
release A's leave later. Arm one selected control per user to hold or observe
several users independently in one guild/session.

The envelope retains the native voice session ID, flags (including
`self_stream`), and member/user snapshot. For
example, hold stream start and stop, then disconnect the user through the typed
route. Releasing the earlier start after disconnect still sends the captured
`self_stream: true` and original channel; replay duplicates that same snapshot.
Neither operation reads current voice/member records, reconnects the user,
starts a stream, or mutates SQLite. Capture without hold, requested release
order, duplicate replay, `sequence: "original"` opt-in, limits, expiry and
cleanup all use the existing control semantics below.

`DELETE /channels/:channelId/messages/:messageId/reactions` returns `204` and
emits one `MESSAGE_REACTION_REMOVE_ALL` with `channel_id`, `message_id` and
`guild_id` for guild messages. `DELETE .../reactions/:emoji` clears that emoji
for every user and emits one `MESSAGE_REACTION_REMOVE_EMOJI` with the same IDs
plus `emoji`: `{ "id": null, "name": "🐝" }` for Unicode, or
`{ "id": "123456789012345678", "name": "party", "animated": false }` for a
custom emoji addressed as `party:123456789012345678` (see
[Custom guild emoji reactions](#custom-guild-emoji-reactions)). URL-encode the
emoji path segment. Unicode keys match exactly; custom emoji match by ID. Both
routes work under `/api/v10`, `/api` and bare paths.

Clear dispatches follow persisted guild setup ownership, scoped to the app's
database, bot ID and exact setup token, with Guild Message Reactions intent.
Existing REST authentication and cross-guild access remain unchanged. DM clears
omit `guild_id`, resolve the registered message-author token and require Direct
Message Reactions intent. A missing registered delivery scope never broadcasts
to unrelated sessions. No-op clears return `204` without an event; rejected
requests do not mutate reactions or emit. A clear preserves the message and
other messages' reactions, and emits neither per-user removes nor message deletes.
Capture/hold happens after the SQLite deletion. Release/replay delivers the
native snapshot even after source-message deletion and never restores reactions.

Capture runs after native intent filtering: missing Guild Messages / Guild
Message Reactions / Guild Voice States intent means no corresponding capture or
delivery. Unrelated event types, guilds, bots and other sessions keep their
existing delivery behavior. `hold` defaults to `false`: observe while delivering
normally. With
`hold: true`, matching events are retained without sending or entering the
normal resume buffer. The database operation still completes immediately.
Payloads are copied at capture time, so message removal cannot invalidate a
late create or reaction payload, and duplicate deletion does not require a second
DELETE. Captured creates retain the original message, channel and guild IDs,
content, author profile and guild member data; release/replay does not look up
current records or recreate a deleted message.

`limit` is an integer from 1–100 (default 20); `ttl_ms` is an integer from
1–180000 (default 30000). Each control also has a fixed 256 KiB serialized payload
budget and a maximum of 100 total release/replay/disconnect operations. Each disconnect
consumes one operation; releasing several events consumes one per event.
Transport observation retains at most 200 delivery records per control, including
RESUME attempts; overflow increments `delivery_observations_skipped` and leaves
normal protocol delivery running. Check both skipped counters when complete
observation matters. There are at most
32 controls per assembled Gateway. Global capacity returns `429`. Overlapping
event selectors for the same guild/session return `409` (see
[member selectors](#member-selectors) for how `member_id` affects overlap). Invalid policy,
malformed JSON and explicit null policy values return `400`.

When count/byte capacity is reached, subsequent matching events **pass through
normally** and increment `skipped`; no entries are evicted and no more events
are held. Assertions should check `skipped === 0` when complete capture matters.
Expiry does not extend when a control is inspected or used.

### `GET /_test/gateway-event-controls/session` — Read-only session preflight

A harness controlling a separate bot process can discover its current Gateway
session without reading the bot's READY, creating an unkeyed capture, emitting
unrelated events, or accessing application Redis:

```text
GET /_test/gateway-event-controls/session?bot_id=:bot&guild_id=:guild
GET /_test/gateway-event-controls/session?bot_id=:bot&guild_id=:guild&session_id=:session
```

`bot_id` and `guild_id` are required positive numeric strings of 1–20 digits.
Optional `session_id` must be exactly 32 lowercase hexadecimal characters. Each
field must appear exactly once when supplied. Missing required fields, unknown
fields (including `ownership_key`), duplicates, empty, whitespace-padded or
malformed IDs return `400` with `{"message":"400: Bad Request","code":0}`.

Returns `200` and **only** `{ "bot_id": "...", "guild_id": "...",
"session_id": "..." }`. With no explicit session, there must be exactly one
open session for that bot whose IDENTIFY token matches the guild's registered
setup token. Sessions for another setup sharing that bot ID do not qualify.
With an explicit session, only that exact open owner is considered, even when
other sessions exist. Selection uses the same resolver and scope checks as
capture creation. Unknown/wrong bot/guild/setup/session or no open owning
session returns `404` with `{"message":"UNKNOWN_SCOPE","code":0}`. Multiple
qualifying sessions without an explicit selection return `409` with
`{"message":"AMBIGUOUS_SESSION","code":0}`. Neither error discloses a candidate
list or foreign session identity. All responses use `Cache-Control: no-store`.

This trusted, unauthenticated test-control GET is strictly read-only: it creates
no capture or ownership reservation, emits no event, changes no sequence,
replay buffer, persisted application state or capture evidence, and does not
prune existing captures. It works independently of capture/reservation capacity.
Retained disconnected sessions are excluded, including an explicitly controlled
disconnect while awaiting RESUME. Retry the read-only `404` while waiting for the
bot process to establish its session; resolve `409` by deliberately selecting a
known exact owner rather than guessing among candidates.

Discovery is a point-in-time observation, not a reservation. Retain its complete
scope and use that `session_id` in keyed POST and by-key GET/DELETE. If that
session closes or is removed before POST, creation returns `404`; if its key was
already retired, POST returns `409`. POST never falls back to a replacement
session. A later deliberate discovery can begin a new attempt with a fresh key.
A protocol RESUME that retains the same session identity remains that owner;
existing controlled capture/RESUME rules still apply. `voice.session_id` is a
voice-state identifier and cannot be used as this Gateway `session_id`.

### Recoverable capture ownership (optional)

Send an optional `ownership_key` with POST, together with an **explicit**
`session_id` from the read-only session preflight above (or `READY.d.session_id`
when available). Keys are case-sensitive, URL-safe opaque
strings matching `[A-Za-z0-9_-]{1,128}`. Generate a fresh random key per capture
attempt and retain its complete address before sending the request. Do not put
credentials in keys. The exact owner is `(ownership_key, bot_id, guild_id,
session_id)`; the selected session's IDENTIFY token must own that guild's setup.
Keyed requests never infer a session or follow a replacement setup/connection.
Unkeyed creation and all existing UUID routes remain supported. POST bodies are
limited to 16 KiB (`413`); no arbitrary dispatch payload is accepted.

Exact recovery and cleanup routes (no capture UUID required):

```text
GET /_test/gateway-event-controls/by-key/:key?bot_id=:bot&guild_id=:guild&session_id=:session
DELETE /_test/gateway-event-controls/by-key/:key?bot_id=:bot&guild_id=:guild&session_id=:session
```

All three query fields are required exactly once. Unknown/extra fields,
duplicates, malformed scope IDs/keys or a keyed POST without `session_id` return
`400`. GET returns `200` with the same live inspection object as GET by UUID,
including `ownership_key`, `id`, normalized policy, original `expires_at`,
immutable `events_captured`, counters and delivery evidence. Keyed POST returns
that inspection object with `201`, also on an identical retry. GET by key and
UUID use `Cache-Control: no-store`. Wrong bot/guild/session or unknown/retired
key returns `404`, without disclosing another owner's ID or policy.

A key is reserved globally within one assembled Gateway instance. A same-key
POST with the same owner and normalized policy reuses the original control and
current evidence; it never renews TTL, capture allowance or delivery quotas.
Event order is ignored for comparison; omitted boolean/default fields equal
explicit defaults. Member selector, event set, hold, application acknowledgements,
original-sequence permission, limit and TTL must match. Changed policy or owner
returns `409` (`CONFLICT`), even if that owner is otherwise valid. Failed POSTs
(`400`, `404`, overlap `409`, capacity `429`, or `413`) reserve no new key.

DELETE by key returns `204` for an exact existing reservation, including one
already retired. It also returns `204` for an unused key in a valid exact
registered session/setup scope: it **reserves a tombstone before creation**.
A disconnected session still registered with the Gateway can establish this
cleanup reservation; a nonexistent session or mismatched setup returns `404`.
Creation and cleanup are synchronous after body validation, so DELETE can run
while POST's body is incomplete. Every later POST for a tombstoned key fails
`409`; cleanup never deletes overlapping controls owned by other keys.
A `404` GET alone does not close an unused key: always DELETE after an ambiguous
outcome and verify `204`. A wrong-scope DELETE returns `404` and changes nothing.

UUID deletion, TTL expiry, ordinary socket disconnect, session invalidation,
setup deletion, guild deletion and scoped/global reset retire keyed controls,
discarding held snapshots just as for legacy captures. Their ownership
reservations remain closed, including after recreating a guild/setup with the
same IDs/token. GET then returns `404`; POST cannot resurrect the key. Capture
count/byte exhaustion continues to fail open and keeps its existing evidence
until normal expiry/cleanup; retries do not replenish it. Explicit controlled
`disconnect`/RESUME retains the original session and key under existing rules.
Setup token replacement invalidates the original capture before further actions;
an old address can still delete its reservation without touching the new setup.

At most 32 live controls and **4096 total ownership reservations** (active plus
retired) are allowed per Gateway instance. Reservations retain only bounded
public identity/policy metadata, never payload snapshots, sockets or credentials.
They are never evicted or cleared by reset: new keyed POSTs or new-key DELETEs
return `429` (`LIMIT`) when capacity is full, while existing-key recovery/cleanup
and legacy controls still work within their own limits. There is deliberately
no ownership eviction endpoint. Restart/reassemble the Gateway for fresh
capacity only after all old HTTP attempts have settled. Controls and reservations
are in memory; restart ends this recovery contract and does not restore holds.

Example harness flow without access to READY, including ambiguous creation:

```typescript
const discoveryQuery = new URLSearchParams({ bot_id: botId, guild_id: guildId })
const discovery = await fetch(
  `${base}/_test/gateway-event-controls/session?${discoveryQuery}`
)
// Retry read-only 404 while the separate bot process starts; 409 is ambiguous.
if (!discovery.ok) throw new Error(`Session discovery: ${discovery.status}`)
const scope = await discovery.json()
if (
  scope.bot_id !== botId ||
  scope.guild_id !== guildId ||
  typeof scope.session_id !== 'string' ||
  !/^[\da-f]{32}$/.test(scope.session_id)
)
  throw new Error('Invalid session discovery response')
// Discovery parsing failure requires no cleanup: it created nothing.
const ownership = {
  ownership_key: crypto.randomUUID(),
  bot_id: botId,
  guild_id: guildId,
  session_id: scope.session_id,
}
const query = new URLSearchParams({
  bot_id: ownership.bot_id,
  guild_id: ownership.guild_id,
  session_id: ownership.session_id,
})
const address = `${base}/_test/gateway-event-controls/by-key/${ownership.ownership_key}?${query}`
try {
  const response = await fetch(`${base}/_test/gateway-event-controls`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...ownership,
      events: ['VOICE_STATE_UPDATE'],
      hold: true,
    }),
  })
  // Retain this exact ownership even if the bot reconnects while POST is in flight.
  // A lost, truncated, malformed or undecodable response leaves outcome unknown.
  // GET address recovers the installed UUID and exact native evidence if needed.
  if (!response.ok) throw new Error(`Capture create: ${response.status}`)
  const capture = await response.json()
  // Exercise native fixtures, inspect/release/replay using capture.id as usual.
} finally {
  // Cancel the POST attempt if still running, then close ownership even if its
  // body may arrive later. Retry this exact DELETE on ambiguous cleanup replies.
  const cleanup = await fetch(address, { method: 'DELETE' })
  if (cleanup.status !== 204)
    throw new Error(`Capture cleanup: ${cleanup.status}`)
}
```

A valid UUID retained in a partial response remains usable through existing ID
routes; key cleanup additionally confirms closure when no UUID was decoded.
Cleanup discards held events, leaves persisted voice/member/application state
unchanged and allows future native voice delivery immediately. A client-side
response parser failure does not change server ownership. Focused real HTTP/WS
coverage is in `src/gateway/event-control-ownership.test.ts`; existing message,
reaction, member and voice control suites cover legacy capture/release/replay.

### `GET /_test/gateway-event-controls/:id` — Inspect capture state

Returns `200` with the policy, `expires_at` (epoch milliseconds), `bytes`,
`skipped`, `operations`, `delivery_observations_skipped`, `awaiting_resume`,
`pause_resume`, `pending_resume`, `pending_resume_heartbeats`,
`pending_resume_last_heartbeat_at`, and `events_captured` in native observation order.

`pending_resume_heartbeats` counts heartbeats received on the current held RESUME
socket. `pending_resume_last_heartbeat_at` is the receipt time of the last such
heartbeat in epoch milliseconds. They are `0` and `null` before any heartbeat,
reset for each new pending RESUME, and return to `0` and `null` when that pending
RESUME is cleared (including gate opening or socket closure).

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
not client acknowledgements or completed callbacks. Buffered dispatches and
RESUME writes count as separate attempts. `last_sequence` is the last attempted
sequence. `delivery_records` supplies the separate transport/application
observations described below. Inspection has no delivery side effects and exposes no bot
token. An unknown, expired, canceled or invalidated control returns `404`.

For voice events too, capture proves server observation and delivery counters
prove send attempts. Even receipt of a frame by a test client does not prove
that the application's voice handler completed; assert its side effects or use
an application/harness completion signal separately.

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
`MESSAGE_CREATE` and `MESSAGE_DELETE` after the message has already disappeared.
Exhausting the 100-delivery budget returns `429` without sending.

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

### Member selectors

`member_id` narrows a control to one existing guild member. It uses the same
positive 1–20 digit string format as the scope IDs; null/malformed selectors
return `400`, and a user who is not currently a member of the guild returns
`404`. The selector matches the subject user of each event:

| Event                 | Matched field |
| --------------------- | ------------- |
| `GUILD_MEMBER_UPDATE` | `d.user.id`   |
| `VOICE_STATE_UPDATE`  | `d.user_id`   |

`events` may combine both (for example one control holding a user's nickname and
voice changes). Every listed event must be one of these member-scoped events;
any other event type (messages, reactions) together with `member_id` returns
`400` with
`{"message":"member_id requires every event to be one of GUILD_MEMBER_UPDATE, VOICE_STATE_UPDATE","code":0}`.
Dispatches of other users never match a selected control and pass through
untouched.

**Overlap and precedence.** At most one control ever matches a dispatch, so no
precedence rule is needed at delivery time: overlap is rejected when arming. For
the same guild and session, a new control conflicts (`409`) with an existing one
when they share at least one event type and either has no `member_id` or both
select the same member. Hence controls for different members coexist, the same
member may have controls for disjoint event types, and an all-member control
cannot coexist with a member-selected control for the same event type (cancel
one first). Every control, selected or not, counts toward the 32-control limit
and has its own `limit`, byte budget, operation budget and TTL. `member_id` is
part of the ownership-key policy: retrying a keyed creation with a different
selector returns `409`. Release, replay, sequence modes, acknowledgements,
disconnect/resume gating, inspection by ID or key and cleanup are unchanged.

### Native member updates and cache preparation

Arm `events: ["GUILD_MEMBER_UPDATE"]` and optionally `member_id` (see
[member selectors](#member-selectors)) to select one existing guild member.

Use the production `PATCH /guilds/:guildId/members/:userId` with `{"nick":"New"}`
or `{"nick":null}`. Unchanged nickname PATCHes also emit a native update, as does
clearing an already-null nickname. The existing `/api/v10` and `/api` prefixes
and `PATCH .../members/@me` work too. Rejected PATCHes produce no capture.
Native member updates (including role mutations) are addressed to the originating
app/database and the guild's registered bot setup token, with Guild Members
intent. Another session for the same setup receives its own ordinary dispatch;
only the selected session is held. Missing Guild Members intent produces no
update or capture, regardless of fixture membership.

Capture stores the full member/user snapshot: nickname, roles, dates, mute/deaf,
user ID, username, `global_name`, avatar and boolean `bot`. Changed, unchanged,
empty-string and cleared nicknames retain their native values. Release/replay
uses this immutable snapshot even after member removal or profile/role changes;
it neither reloads fixtures nor updates the DB again. Use real member REST reads
or the initial `GUILD_CREATE.members` to prepare/assert a client's old cache.
`GUILD_CREATE` requires Guilds intent. Fauxcord sends its existing member list;
client cache policies can still exclude members or discard updates. These
controls do not set a discord-bot cache or run its handlers.

### Transport observation and explicit application acknowledgement

Set `application_ack: true` when arming (default `false`; non-booleans return
`400`) to request an acknowledgement barrier for each captured delivery. Each
`delivery_records` entry has a unique `id`, the attempted `sequence`, a `source`
(`native`, `release`, `replay`, or `resume`), `transport`, and `application`:

- `buffered`: no write was attempted on a closed/closing socket; normal session
  replay history retains the event. A subsequent RESUME gets a new record.
- `queued`: the server started a socket write and its callback has not finished.
- `sent`: the WebSocket write callback succeeded. This means a successful local
  socket write, **not** client receipt, handler invocation, or callback completion.
- `failed`: a write threw or its callback reported an error. Buffered history
  still follows the existing session replay rules for native/new-sequence writes.

`application` is `not_requested` without a barrier, otherwise `pending` until an
explicit consuming-client/harness assertion changes it to `acknowledged`.
Requested records expose their own `ack_token`. Inspecting a capture, releasing
it, replaying it, successful writes and heartbeat sequences **never** acknowledge
application work. Buffered/failed attempts cannot be acknowledged; select the
subsequent successfully sent RESUME delivery instead. Each repeat has its own
ID/token even if `sequence: "original"` repeats the same sequence.

`POST /_test/gateway-event-controls/:id/ack` accepts:

```json
{ "delivery_id": "DELIVERY_UUID", "ack_token": "THIS_DELIVERY_ACK_TOKEN" }
```

Returns `200` with updated observation. Repeating that exact acknowledgement is
idempotent. Malformed/missing UUIDs return `400`; unknown/cross-control delivery
IDs, wrong tokens, or a delivery without a requested barrier return `404`;
a non-sent delivery returns `409`. Cancellation, expiry, reset and invalidation
remove acknowledgement records/tokens; acknowledgements afterwards return `404`.
Acknowledging one delivery cannot satisfy another replay or unrelated event.
Poll **the selected delivery's** `application` for its completion barrier;
there is no automatic whole-control completion claim. Overflowed observations
cannot supply a barrier, so assert `delivery_observations_skipped === 0`.

The consuming application or harness must correlate the native event with the
captured event and delivery (using the session, native payload, sequence and
attempt order), await the actual handler/callback completion, then submit this
explicit assertion using that delivery's token. Tokens are carried by the test
HTTP API, never injected into Discord Gateway payloads. For repeated original
sequences, a harness must track the occurrence order; a client can discard those
frames and no acknowledgement should then be sent. These unauthenticated test
APIs trust the harness assertion; Fauxcord cannot independently inspect callback
execution. **Unmodified discord-bot does not provide this acknowledgement.** A
downstream harness/application completion hook is necessary to observe
`NicknameChangeLogHandler` completion; this task supplies only Fauxcord
prerequisites and does not establish complete bot integration coverage.

### `POST /_test/gateway-event-controls/:id/disconnect` — Deterministic reconnect

Send `{}` for an immediate protocol reconnect, or `{"pause_resume":true}` to
also close a resume gate. `pause_resume` defaults to `false`; invalid values,
unknown fields or malformed JSON return `400`. The action sends Gateway
RECONNECT (op7), closes the current socket, and retains only this control bound
to its original session, ownership, capture policy, TTL and budgets. Returns
`200` with `session_id`, the server's `sequence` checkpoint, `awaiting_resume`
and `pause_resume`. The checkpoint is the server high-water sequence, not a
client receipt or application completion assertion. Resume with the client's
actual last received sequence; a cooperating harness may explicitly checkpoint
before generating buffered updates.

With `hold: false`, production PATCHes during this disconnect enter normal
bounded session history and are captured with `transport: "buffered"`. With
`hold: true`, they stay held and never enter normal resume history. Release and
replay return `409` while awaiting resume. A repeated disconnect returns `409`;
operation-budget exhaustion returns `429`; unknown/expired scope returns `404`.
Ownership and intent filtering still apply throughout the gap.

With `pause_resume: true`, an authenticated, structurally valid RESUME attempt
waits at the gate without receiving a fabricated success or invalid-session
response. Inspection exposes `pending_resume: true`. One pending connection is
retained per control, and one socket can belong to only one pending gate across
all controls. A second RESUME attempt on an already-pending socket (including
another session/control) receives ordinary INVALID_SESSION (op9, false) without
changing the first pending owner or the second gate. Canceling/expiring the
rejected gate cannot close the first owner's socket. Opening the rejected gate
only opens its policy; it does not replay or bind the first owner's connection.
Use separate fresh sockets to wait on two gates simultaneously.
A socket already bound to an existing session also receives INVALID_SESSION
without admission to the gate, so cancellation/expiry cannot disrupt that
session or its controls. Use a fresh connection for a gated RESUME.
A closed pending socket clears the pending slot without opening the gate.
Heartbeats on the validated pending socket keep being ACKed and refresh the
session's ordinary heartbeat timeout while the gate stays closed. Inspection's
`pending_resume_heartbeats` and `pending_resume_last_heartbeat_at` let a harness
wait for that socket's first heartbeat before continuing a timed hold. When those
heartbeats stop, the session still expires after two heartbeat intervals; holding
the gate alone does not keep it alive. The control's fixed TTL still applies:
set `ttl_ms: 180000` when a hold must span a heartbeat and a one-minute bot tick.
A successful IDENTIFY or RESUME on that socket clears its deferred attempts
before binding the new session; opening or canceling the old gate cannot
restore the old session or close the repurposed connection.
No credentials or sockets are exposed through inspection. Native updates can be
PATCHed and observed deterministically while an automatically reconnecting client
waits. Cancellation/expiry/reset/session removal closes a pending socket and
cleans its listener; the original native replay buffer remains subject to
ordinary session lifetime. Cancellation does not retract previously delivered
or normally buffered native events.

### `POST /_test/gateway-event-controls/:id/resume` — Open the resume gate

Send `{}`. Returns `200` with observation, opens the gate, and retries the one
waiting RESUME through the production protocol/session machinery. If no client
has arrived yet, the next valid RESUME can proceed. An unopened gate is required
(`409` otherwise); malformed/nonempty JSON returns `400`; stale scope returns
`404`. This does not forge a session or bypass token/cursor validation.

Successful RESUME retains the exact session sequence and replays buffered native
updates in normal buffer order with their original sequences, then emits a fresh
`RESUMED`. The control rebinds to that connection and records separate `resume`
write attempts. No DB mutation repeats. Further ordinary connection replacement
invalidates it; use another explicit disconnect for a second controlled gap.
Bad credentials/cursors never steal scope. Negative, fractional, future or
unavailable cursors get INVALID_SESSION before admission to the gate. A gated
cursor is revalidated when the gate opens, since the replay buffer can expire
while it waits. An invalid cursor after gate opening
leaves the original disconnected session/control available for a valid retry.
The existing 100-entry replay buffer, heartbeat session lifetime and fixed
control TTL still apply; the gate does not guarantee retention beyond them.

### `DELETE /_test/gateway-event-controls/:id` — Cancel and discard

Returns `204` for a known control and `404` otherwise. Cancellation drops all
held payloads and observation history without flushing them; already sent
frames remain sent. Expiry, socket disconnect, session removal/replacement,
ordinary resume onto a different socket, setup deletion, and `/_test/reset`
do the same. An explicit `disconnect` preserves only its selected control for
that exact session; other controls on that connection are canceled. A retained
control still expires, is canceled by DELETE/reset/session removal, and is
invalidated by any subsequent ordinary disconnect or session replacement.
A nonempty-token reset clears only that setup's controls; an omitted/empty-token reset and
Gateway shutdown clear all. Controls are in memory and do not survive restart.
Deleted guild/bot scope is also invalidated before further capture or actions.

What is deterministic: native payload capture, bounded observation, explicit
release selection, and frame send order on one connected WebSocket. Poll
observation until the expected events appear, then select their UUIDs. A useful
scenario is to hold reaction ADD/REMOVE and DELETE, perform the real operations,
then release DELETE before the captured reactions. REST can confirm the message
is absent before release.

For a human create/delete race, arm `events: ["MESSAGE_CREATE", "MESSAGE_DELETE"]`
with `hold: true`, create a registered human's message through
`POST /_test/channels/:channelId/messages`, and delete its returned ID through
`DELETE /channels/:channelId/messages/:messageId`. Both database operations
complete while the native Gateway envelopes remain held. Inspect the control,
then release the DELETE UUID followed by the CREATE UUID with `sequence: "new"`
to deliver deletion before the delayed create. Reverse those UUIDs to deliver
create before deletion. Replay the released CREATE UUID to deliver the same
creation snapshot again; repeated replay is supported within the delivery budget.
Alternatively, hold only `MESSAGE_CREATE` to let native DELETE delivery proceed
normally before releasing the held create.

TCP frame ordering does **not** reproduce or control application handler
scheduling. Libraries may drop original-sequence frames, update caches before
callbacks, or run handlers concurrently. To prove one callback finished before
another starts, the consuming test harness needs its own application-level
barrier/acknowledgement; a release HTTP response alone proves only server queueing.
No artificial TCP packet reordering, sleeps, handler acknowledgements, arbitrary
forged dispatches, or general network chaos are modeled by these controls.

---

## Forced re-IDENTIFY of a live Gateway session

`/_test/gateway-session-invalidations` makes the client of one exact, live
Gateway session lose that session and log in again with IDENTIFY, without
restarting or gracefully shutting down the bot process. The client then
receives a fresh `READY` and a `GUILD_CREATE` per guild built from the state
current at IDENTIFY time (members, channels and `voice_states`, including
states prepared with `emit: false` and states changed live). Use it for
"reconnect and restore state" scenarios that RESUME cannot exercise:
RESUME replays missed events and never rebuilds `GUILD_CREATE` snapshots.
`POST /_test/gateway-event-controls/:id/disconnect` is unchanged and still
produces a RESUME. These Fauxcord-only, unauthenticated routes have no Discord
OpenAPI manifest entries.

### Protocol behavior

When the invalidation is applied, Fauxcord atomically:

1. records the session's server sequence high-water mark (`sequence`),
2. removes the session, so it receives no further dispatch, any capture or
   gate on it from `/_test/gateway-event-controls` is canceled, and any later
   RESUME naming it receives INVALID_SESSION (op 9, `d: false`),
3. sends Gateway INVALID_SESSION (op 9) with `d: false` on its socket, and
4. closes that socket with close code `4009` (Session timed out).

Discord documents `d: false` as "not resumable": the client must discard its
session ID and sequence and send a new IDENTIFY. `4009` likewise asks for a new
session, so a client that ignored op 9 still reconnects, and its RESUME is then
rejected with op 9 `d: false`. DiscordGo handles op 9 by closing its socket,
clearing `sessionID`, `sequence` and `resumeGatewayURL` when `d` is false, and
calling `reconnect()`, whose `Open()` sends IDENTIFY when no session is
retained. This was verified against the `bwmarrin/discordgo` fork
`github.com/0x00-sys/discordgo v0.0.0-20260923174158-eda8642daf18` (the
`wsapi.go` op 9 handler and `Open()`); its startup path also treats 4009 as
a reason to start a new session. Upstream `bwmarrin/discordgo` v0.29.0 has the
same op 9 handling and is exercised by `compat/go-discordgo`
(`invalidate-session-reidentify`). Libraries that wait 1–5 seconds before
re-identifying, as Discord recommends, are supported; observe with `wait_ms`
instead of sleeping.

### `POST /_test/gateway-session-invalidations` — Invalidate one session

```json
{
  "ownership_key": "reidentify-0b8a7d6e",
  "bot_id": "111111111111111111",
  "guild_id": "222222222222222222",
  "session_id": "0123456789abcdef0123456789abcdef",
  "ttl_ms": 60000
}
```

| Field           | Required | Meaning                                                                                                                                                  |
| --------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ownership_key` | ✅       | Fresh opaque key chosen **before** sending, `[A-Za-z0-9_-]{1,128}`. Never put credentials in it.                                                         |
| `bot_id`        | ✅       | Registered bot user ID (1–20 digit snowflake).                                                                                                           |
| `guild_id`      | ✅       | A guild of that bot's setup; proves the session's IDENTIFY token owns it. All of its guilds are affected.                                                |
| `session_id`    | ✅       | Exact Gateway session to invalidate (32 lowercase hex characters). Never inferred.                                                                       |
| `ttl_ms`        | —        | Observation lifetime, integer `1`–`120000`, default `60000` (`trigger: "resume"`: `1`–`300000`, default `180000`). The invalidation itself is permanent. |
| `trigger`       | —        | `"immediate"` (default) invalidates now; `"resume"` rejects the session's next RESUME instead — see [Failed RESUME](#failed-resume-trigger-resume).      |

Use the read-only preflight
`GET /_test/gateway-event-controls/session?bot_id=:bot&guild_id=:guild` to
discover `session_id` without access to the bot's READY; it returns `409`
`AMBIGUOUS_SESSION` when the bot has several live sessions for that setup, and
`404` until a session is open. `voice.session_id` is a voice-state identifier,
not a Gateway session ID.

Responses:

- `201` with the observation object below, for a new invalidation **and** for a
  retry with the same key, owner and `ttl_ms` while the observation is live. A
  retry never invalidates again, never renews TTL and returns the original
  `sequence`.
- `400` (`{"message":"400: Bad Request","code":0}`) for malformed JSON, a
  non-object, unknown fields, missing `ownership_key`/`session_id`, or invalid
  IDs, key or TTL. `413` for bodies over 16 KiB.
- `404` `UNKNOWN_SCOPE` when the session is not registered (never existed,
  already invalidated, heartbeat-expired) or does not belong to that bot and
  guild setup (including another bot's session or another setup sharing the
  bot ID). Failed requests reserve no key.
- `409` `INVALID_STATE` (immediate trigger only) when the session is
  registered but its socket is not open or is a
  [zombie connection](#zombie-gateway-connections): a dropped connection
  retained for RESUME, or an explicit `gateway-event-controls` disconnect
  awaiting RESUME. Nothing changes and the
  key stays unused; after the client resumes on a new socket the session is
  live again and can be invalidated.
- `409` `CONFLICT` when the key is already reserved with a different owner,
  `ttl_ms` or `trigger`, has been closed by DELETE, or its observation retired.
- `409` `BUSY` when another live observation for the same setup token is
  still open (has no `replacement` yet). A replacement IDENTIFY carries no
  link to the session it replaces, so only one open observation per setup
  token is allowed; this keeps attribution exact. Wait for its replacement,
  or DELETE it, before invalidating another session of that setup. Nothing
  changes and the key stays unused.
- `429` `LIMIT` when 32 observations are live or 4096 ownership reservations
  (active, retired and tombstoned, never evicted) exist in this Gateway
  instance.

Because `session_id` is mandatory and a removed session is never registered
again, a duplicated, delayed or retried POST — with the same or a new key —
can never invalidate the replacement session.

### Observation object

```json
{
  "id": "4f0c3c87-5b1e-4f7e-a0e3-7f5bb8a8f0d1",
  "ownership_key": "reidentify-0b8a7d6e",
  "bot_id": "111111111111111111",
  "guild_id": "222222222222222222",
  "session_id": "0123456789abcdef0123456789abcdef",
  "trigger": "immediate",
  "sequence": 42,
  "op": 9,
  "resumable": false,
  "close_code": 4009,
  "transport": "sent",
  "status": "identified",
  "resume_rejection": null,
  "replacement": {
    "session_id": "fedcba9876543210fedcba9876543210",
    "...": "same shape as identifies[n]"
  },
  "ttl_ms": 60000,
  "invalidated_at": 1791936000000,
  "expires_at": 1791936060000,
  "identifies": [
    {
      "session_id": "fedcba9876543210fedcba9876543210",
      "intents": 129,
      "identified_at": 1791936000150,
      "guilds_intent": true,
      "ready": {
        "sequence": 1,
        "guild_ids": ["222222222222222222", "232323232323232323"],
        "transport": "sent"
      },
      "guild_creates": [
        {
          "guild_id": "222222222222222222",
          "sequence": 2,
          "transport": "sent",
          "member_count": 2,
          "channel_count": 1,
          "voice_states": [
            {
              "user_id": "888888888888888888",
              "channel_id": "555555555555555555",
              "session_id": "c0ffee...",
              "self_stream": true,
              "self_video": false
            }
          ],
          "voice_states_total": 1
        }
      ],
      "guild_creates_sent": 1,
      "guild_creates_skipped": 0,
      "state": "complete",
      "complete": true
    }
  ],
  "identifies_skipped": 0,
  "resumes_rejected": 0
}
```

- `session_id`/`sequence`: the invalidated session and its last server
  sequence (a server high-water mark, not a client receipt).
- `transport`: socket write progress of the op 9 frame (`queued`, `sent`,
  `failed`).
- `status`: `armed` while a `trigger: "resume"` invalidation has not been
  applied yet, `awaiting_identify` while no attempt is in progress (none yet, or
  all failed), `identifying` while an attempt's frames are still being
  written, and `identified` once `replacement` is set.
- `identifies`: replacement attempts, in order. An attempt is a successful
  IDENTIFY with the invalidated session's setup token on any **other** socket
  after invalidation, recorded only while the observation has no pending or
  complete attempt (so after a `failed` attempt the next IDENTIFY is recorded,
  and after a replacement nothing more is). At most 4 attempts are retained:
  a new attempt evicts the oldest failed one, counted in `identifies_skipped`,
  so repeated failures never prevent observing a later replacement. Sessions that existed before the invalidation,
  other bots and other setups never appear. Each attempt reports the new
  `session_id`, READY's sequence and guild stubs, `guild_creates_sent`, and
  one summary per `GUILD_CREATE` written (at most 50 summaries, further ones
  counted in `guild_creates_skipped`; 100 voice states each, with the full
  count in `voice_states_total`).
- `state` per attempt: `complete` when READY and a `GUILD_CREATE` for every
  READY guild were `sent` (READY alone when the replacement lacks the `Guilds`
  intent, reported as `guilds_intent: false`); `failed` when one of them could
  not be written, including a socket that closed before the snapshot was
  written (`buffered`); otherwise `pending`. `complete` mirrors
  `state === "complete"`. Completion counts every written GUILD_CREATE, not
  just the retained summaries.
- `replacement`: the first `complete` attempt, or `null`.
- `transport` values on READY/GUILD_CREATE are server socket writes; `sent`
  means the frame was handed to the OS, not that the client processed it.
- `resumes_rejected`: RESUME attempts naming the invalidated session that
  received INVALID_SESSION. DiscordGo normally shows `0` because op 9 `d: false`
  makes it IDENTIFY directly.

HTTP 2xx from POST only proves the server applied the invalidation. Prove the
re-login with `status: "identified"` and `replacement.session_id` (different
from `session_id`); correlate with the bot's own READY session ID when
available. Attribution is server-side and token-based: if several processes
or shards share one setup token, any of them may supply the first IDENTIFY
after the invalidation, so compare `replacement.session_id` with the process
you expect.

### `GET /_test/gateway-session-invalidations/by-key/:key` — Recover and wait

```text
GET /_test/gateway-session-invalidations/by-key/:key?bot_id=:bot&guild_id=:guild&session_id=:session
GET /_test/gateway-session-invalidations/by-key/:key?bot_id=:bot&guild_id=:guild&session_id=:session&wait_ms=10000
```

Returns `200` with the observation for the exact owner, or `404` for an
unknown, retired, tombstoned or wrong-scope key (without disclosing another
owner). Each scope field is required exactly once; unknown/duplicate fields or
malformed values return `400`. `wait_ms` (optional integer `0`–`30000`) holds
the response until `replacement` is set or the observation retires, then answers immediately: `200` with the current observation (which
may still be `awaiting_identify` when the wait elapsed) or `404` if it retired
meanwhile. At most 64 concurrent waits per Gateway instance (`429` beyond).
Responses use `Cache-Control: no-store`. `GET /_test/gateway-session-invalidations/:id`
accepts the same optional `wait_ms` and no other query fields.

### `DELETE /_test/gateway-session-invalidations/by-key/:key` — Close ownership

Same exact query (no `wait_ms`). Returns `204` and retires the observation for
an existing reservation (live, retired or tombstoned). For an **unused** key it
reserves a tombstone and returns `204` when the bot/guild setup scope is valid,
and the named session, if still registered, belongs to it; a later POST with
that key returns `409` and invalidates nothing. Because `session_id` is never
reused, a tombstone is also accepted when the session no longer exists. A
wrong scope returns `404` and changes nothing. DELETE never reconnects or
restores the invalidated session. `DELETE /_test/gateway-session-invalidations/:id`
retires by observation ID (`204`/`404`).

### Lifecycle

TTL expiry, DELETE, `/_test/reset` (all, or the matching setup token),
`DELETE /_test/setup/:token`, deleting the scoped guild and Gateway shutdown
retire observations; their keys stay closed. Observations and reservations are
in memory and do not survive restart. Retiring an observation never undoes the
invalidation, and it does not affect the replacement session.

### Harness flow without sleeps

```typescript
const discovery = await fetch(
  `${base}/_test/gateway-event-controls/session?bot_id=${botId}&guild_id=${guildId}`
)
if (!discovery.ok) throw new Error(`Session discovery: ${discovery.status}`)
const { session_id: sessionId } = await discovery.json()
const key = `reidentify-${crypto.randomUUID()}`
const query = new URLSearchParams({
  bot_id: botId,
  guild_id: guildId,
  session_id: sessionId,
})
const address = `${base}/_test/gateway-session-invalidations/by-key/${key}?${query}`
try {
  // A lost or truncated response leaves the outcome unknown; the GET below
  // recovers it, and a retry with the same key is idempotent.
  await fetch(`${base}/_test/gateway-session-invalidations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ownership_key: key,
      bot_id: botId,
      guild_id: guildId,
      session_id: sessionId,
    }),
  }).catch(() => undefined)
  const observed = await fetch(`${address}&wait_ms=15000`)
  if (observed.status !== 200) throw new Error('Invalidation was not applied')
  const observation = await observed.json()
  const { replacement } = observation
  if (!replacement || replacement.session_id === sessionId)
    throw new Error('No fresh IDENTIFY with GUILD_CREATE was observed')
  // Assert application state restored from replacement.guild_creates.
} finally {
  // Closes the key even if a delayed POST arrives later.
  const cleanup = await fetch(address, { method: 'DELETE' })
  if (cleanup.status !== 204) throw new Error(`Cleanup: ${cleanup.status}`)
}
```

Focused real HTTP/WS coverage is in
`src/gateway/session-invalidations.test.ts`.

### Failed RESUME (`trigger: "resume"`)

With `"trigger": "resume"` the POST does not touch the live connection. It
**arms** a rejection of the session's next authenticated RESUME, so a test can
drop the connection, generate events during the gap, and prove that the client
recovers through a fresh IDENTIFY and `GUILD_CREATE` snapshots instead of a
replay. Discord documents this path in
[Resuming](https://docs.discord.com/developers/events/gateway#preparing-to-resume):
a RESUME that cannot be honored is answered with INVALID_SESSION (op 9) and
`d: false`, after which the app disconnects, opens a new connection and sends
IDENTIFY. Discord gives no protocol-level reason; in practice it happens when
the session expired or its missed events can no longer be replayed.

The TTL starts when the rejection is armed and must cover the whole gap until
the client's RESUME. That includes a zombie's detection delay: DiscordGo needs
up to two heartbeat intervals (2 × 41.25 s by default), plus its reconnect.
The resume trigger therefore defaults to `180000` ms and allows up to
`300000`.

Arming requires a registered session of that bot and guild setup. The socket
may be open, dropped, waiting behind an explicit `disconnect` or silenced as a
[zombie](#zombie-gateway-connections). `INVALID_STATE` does not apply.
`BUSY`, `LIMIT`, `CONFLICT`, ownership keys, `wait_ms`, DELETE and lifecycle
behave exactly as for the immediate trigger. An armed observation counts as
open for `BUSY`.

When a RESUME arrives that names the session and carries its token, Fauxcord:

1. answers it with INVALID_SESSION (op 9, `d: false`) on the RESUME socket,
   which stays open (Fauxcord's usual RESUME rejection),
2. removes the session and its replay buffer, so the events buffered during
   the gap are **discarded** and never delivered one by one, and
3. starts observing the replacement IDENTIFY. That IDENTIFY may arrive on
   any socket, including the one that carried the RESUME.

The rejection also applies when the cursor could no longer be replayed
(overflow). Such a RESUME is rejected immediately, even while a `pause_resume`
gate is closed, because only replayable cursors enter the gate. The removed
session cancels the event control, so a later `/resume` returns `404`. A
replayable RESUME waits behind a `pause_resume` gate and is rejected when the
gate opens. The `/resume` response then shows the opened gate, and the event
control is canceled together with the removed session. A RESUME with another
token, or one for another session, is unaffected. If the armed observation
retires (TTL, DELETE, reset), nothing is applied and later RESUMEs succeed
normally.

If the session disappears before any RESUME (heartbeat timeout, re-IDENTIFY on
its socket), the observation applies at that moment with reason
`session_removed`. The client's later RESUME is then rejected naturally and
counted in `resumes_rejected`.

Differences from the immediate trigger in the observation object:

| Field              | `trigger: "resume"`                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------- |
| `status`           | `armed` until applied, then as above                                                                      |
| `sequence`         | `null` until applied, then the server high-water mark at rejection (including gap events)                 |
| `invalidated_at`   | `null` until applied                                                                                      |
| `transport`        | `null` until applied; write progress of the op 9 answering the RESUME; stays `null` for `session_removed` |
| `close_code`       | always `null` (Fauxcord does not close a socket)                                                          |
| `resume_rejection` | `null` until applied, then `{reason, at, client_sequence, replay_available, discarded}`                   |
| `resumes_rejected` | includes the forced rejection                                                                             |

`resume_rejection.reason` is `forced` or `session_removed`. `client_sequence`
is the RESUME's `seq`. `replay_available` reports whether the replay buffer
could still have served it (`false` after overflow). `discarded` is
`{count, first_sequence, last_sequence}` of buffered dispatches after the
client's sequence. `client_sequence`, `replay_available` and `discarded` are
`null` for `session_removed`.

```typescript
// 1. Arm before the gap; 2. drop the connection (event-control disconnect,
// zombie, or a network drop); 3. change state; 4. wait for the replacement.
await post('/_test/gateway-session-invalidations', {
  ownership_key: key,
  bot_id: botId,
  guild_id: guildId,
  session_id: sessionId,
  trigger: 'resume',
})
await post(`/_test/gateway-event-controls/${controlId}/disconnect`, {})
await patch(`/_test/guilds/${guildId}/voice-states/${userId}`, {
  self_stream: false,
})
const observation = await get(`${address}&wait_ms=15000`)
// observation.resume_rejection.discarded lists the events that were never
// delivered individually; observation.replacement.guild_creates holds the
// snapshot the client rebuilt its state from.
```

#### Alternative: natural replay-buffer overflow

Each session keeps its most recent **100** dispatches for RESUME. If more
than 100 dispatches are generated for the session while it is disconnected,
the RESUME's cursor is older than the buffer and Fauxcord answers op 9
`d: false` with no control involved. The client then IDENTIFYs. Two
deviations from Discord apply: Fauxcord keeps the unresumable session
registered until its heartbeat timeout (it rejects only that cursor), and
nothing observes the replacement IDENTIFY. Arm `trigger: "resume"` as well to
observe it: the overflow then shows up as `replay_available: false`.

---

## Zombie Gateway connections

`/_test/gateway-zombie-connections` turns one exact live Gateway connection
into a _zombie_. The socket stays open, but the server stops answering. It
writes no HEARTBEAT_ACK (op 11) and no dispatches to that socket, and still
reads everything the client sends. Native dispatches generated meanwhile are
sequenced and stored in the session's replay buffer exactly as for a closed
socket. Use it to test the window in which a client cannot see events
because it has not yet noticed that its connection is dead.

Discord describes the client side in
[Heartbeat Interval](https://docs.discord.com/developers/events/gateway#heartbeat-interval):
if a client does not receive a heartbeat ACK between its attempts at sending
heartbeats, the connection may be "zombied". The client should then terminate
the connection with any close code besides `1000` or `1001`, reconnect and
RESUME. On a successful RESUME the Gateway sends the missed events in order
and finishes with RESUMED
([Preparing to Resume](https://docs.discord.com/developers/events/gateway#preparing-to-resume)).
The DiscordGo fork used by szymboot (`github.com/0x00-sys/discordgo
v0.0.0-20260923174158-eda8642daf18`, `wsapi.go` `heartbeat()`) checks on each
tick whether the previous heartbeat was acknowledged. If it was not, DiscordGo
closes with `1012` (service restart) and calls `reconnect()`, which RESUMEs.
Detection therefore takes between one and two heartbeat intervals after the
zombie starts: about 41–83 s with the default 41.25 s interval.

**Faster detection in tests.** Set the environment variable
`GATEWAY_HEARTBEAT_INTERVAL_MS` (integer `100`–`600000`, default `41250`) to
change the `heartbeat_interval` Fauxcord announces in HELLO. Clients
heartbeat at the announced interval, so with `1000` DiscordGo detects a
zombie within 1–2 s. The server's heartbeat timeout scales with it (two
intervals).

### `POST /_test/gateway-zombie-connections` — Silence one connection

```json
{
  "ownership_key": "zombie-0b8a7d6e",
  "bot_id": "111111111111111111",
  "guild_id": "222222222222222222",
  "session_id": "0123456789abcdef0123456789abcdef",
  "ttl_ms": 180000,
  "hold_reconnect": true,
  "reconnect_hold_ttl_ms": 180000
}
```

| Field                   | Required | Meaning                                                                                                                                                           |
| ----------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ownership_key`         | —        | Optional fresh opaque key `[A-Za-z0-9_-]{1,128}` for idempotent retry, recovery and tombstoning.                                                                  |
| `bot_id`                | ✅       | Registered bot user ID.                                                                                                                                           |
| `guild_id`              | ✅       | A guild of that bot's setup, proving the session's IDENTIFY token owns it.                                                                                        |
| `session_id`            | ✅       | Exact Gateway session (32 lowercase hex characters), e.g. from `GET /_test/gateway-event-controls/session`.                                                       |
| `ttl_ms`                | —        | Maximum zombie duration, integer `1`–`300000`, default `180000`.                                                                                                  |
| `hold_reconnect`        | —        | Boolean, default `false`. Holds the client's reconnect after the zombie ends until the test releases it; see [Reconnect hold](#reconnect-hold-hold_reconnect). |
| `reconnect_hold_ttl_ms` | —        | Maximum hold duration, integer `1`–`300000`, default `180000`. Only allowed with `hold_reconnect: true`; the hold auto-releases when it elapses.                   |

Responses: `201` with the record below. A keyed retry with the same owner,
`ttl_ms`, `hold_reconnect` and `reconnect_hold_ttl_ms` returns the same record.
`400` is returned for malformed bodies, unknown fields, invalid IDs, key or
TTLs, a non-boolean `hold_reconnect`, or `reconnect_hold_ttl_ms` without
`hold_reconnect: true`, and `413` for bodies over 16 KiB.
`404` `UNKNOWN_SCOPE` means the session is not registered or not in that
bot/guild setup. `409` `INVALID_STATE` means its socket is not open (dropped,
or awaiting RESUME after a disconnect) or is already a zombie. `409`
`CONFLICT` means the key is reserved for another owner or TTL, or is closed.
`429` `LIMIT` means 32 live records or 4096 key reservations exist.

Only that connection is affected. Other sessions of the same bot, other bots
and other setups keep receiving ACKs and dispatches. While a connection is a
zombie, `POST /_test/gateway-session-invalidations` (immediate trigger) and
`POST /_test/gateway-event-controls/:id/disconnect` for its session return `409`
`INVALID_STATE`, because neither op 9 nor op 7 could reach the client. Captures
keep working, and releases are buffered like any other dispatch.

### How the zombie ends

| End                                                        | `ended_by`        | Effect                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The client closes the socket                               | `client_close`    | Normal detection. `close.code` is the client's code, `initiated_by: "client"`. With `hold_reconnect`, the reconnect hold starts.                                                                                                                                                                                              |
| The client reconnects first (only with `hold_reconnect`)   | `reconnect`       | A new connection on the session's `resume_gateway_url`, or a RESUME on another connection, arrives while the zombie socket is still open. The silenced socket is dropped with `4000` and the hold starts with that connection as its first blocked attempt.                                                                   |
| `POST /_test/gateway-zombie-connections/:id/end` with `{}` | `end`             | The server drops the socket with close code `4000` (Unknown error, reconnect allowed). Returns `200` with the record; `409` when the zombie already ended, `404` when unknown, `400` for a nonempty body. With `hold_reconnect`, the reconnect hold starts, as for a client close.                                            |
| `ttl_ms` elapses                                           | `ttl`             | As `end`, but never starts a reconnect hold: `ttl_ms` is the safety bound of the zombie phase, so the client may RESUME at once.                                                                                                                                                                                              |
| The client RESUMEs on a new socket first                   | `resume`          | The silenced socket is dropped with `4000`.                                                                                                                                                                                                                                                                                   |
| The session is removed                                     | `session_removed` | The status becomes `session_lost`; nothing is replayed. Examples: a rejected RESUME on another socket, or the heartbeat timeout. A still-open zombie socket is closed with `4009`, so it is not left ACKing for a session that no longer exists. A re-IDENTIFY on the zombie socket itself keeps it open for its new session. |
| DELETE, `/_test/reset`, setup or guild deletion            | (record retired)  | An active zombie socket is dropped with `4000` first, so the client can still RESUME.                                                                                                                                                                                                                                         |

After the zombie ends the session is an ordinary disconnected session. The
client's RESUME (on a new socket, with its last received sequence) replays
every buffered dispatch with its **original** sequence number, followed by
RESUMED. Combine with
[`trigger: "resume"`](#failed-resume-trigger-resume) to reject that RESUME
instead.

**Heartbeat timeout interaction.** Fauxcord closes a session (`4009`) and
discards it when no HEARTBEAT arrives for two heartbeat intervals (82.5 s by
default). Heartbeats
on a zombie connection are still received and still re-arm that timeout. Only
the ACK is withheld, so the server never reaps the session while the client
keeps heartbeating, however long detection takes. After the client closes the
socket, the session remains resumable until two intervals after the last
heartbeat the server received. This is at least one interval for a client that detects
on its next tick. A client that stops heartbeating entirely is reaped by the
timeout: the record becomes `session_lost` and the RESUME gets op 9 `d: false`.
A [reconnect hold](#reconnect-hold-hold_reconnect) suspends this timeout while
it lasts.

### Reconnect hold (`hold_reconnect`)

With `hold_reconnect: true`, Fauxcord keeps the client from completing its
reconnect after the zombie ends, until the test releases the hold. Use it to
test what a client does while its Gateway is down after detection, e.g. a bot
that pauses periodic work until RESUMED: without the hold, the client
reconnects and RESUMEs within milliseconds.

**Where the client is stopped.** The hold works **before HELLO**, not at
RESUME. Some clients start heartbeating and consider themselves connected
right after sending RESUME. Holding the RESUME frame itself, as the event
controls' `pause_resume` gate does, would be too late for them. Instead:

- READY's `resume_gateway_url` is per session:
  `ws(s)://<BASE_URL host>/_gateway/resume/<session_id>`. That path (also with
  a trailing slash) serves the same Gateway as `/`, with any query string such
  as `?v=10&encoding=json`. Fauxcord uses it only to recognize, before HELLO,
  which session a new connection wants to RESUME. IDENTIFY on the plain URL is
  unchanged.
- While the hold is active, a new connection on that session's resume URL is
  accepted but gets **no HELLO (op 10)**, and anything it sends is ignored. On
  release, every waiting connection gets HELLO immediately, so the client
  RESUMEs at once instead of after its next backoff.
- A client that ignores `resume_gateway_url` and RESUMEs on the plain URL gets
  HELLO, but its RESUME is **deferred** until the release and then processed
  normally. This is weaker: the client has already sent RESUME. Libraries that
  resume on `/` include serenity 0.12, discordgo v0.29.0 and sleepy-discord.
- IDENTIFY, other sessions of the same bot, other bots and other setups are
  never held.

DiscordGo (fork used by szymboot, `wsapi.go`) dials `resume_gateway_url` +
`?v=10&encoding=json` when it has a session and sequence. It then waits for
HELLO up to the dialer's `HandshakeTimeout` (45 s by default). Without HELLO it
closes the socket and retries after 1 s, 2 s, 4 s, … (max 600 s). A long hold
therefore spans several attempts. Each attempt is counted, and the attempt
waiting at release time gets HELLO right away.

**Session lifetime.** While held, the client cannot heartbeat, so the session's
heartbeat timeout is suspended and the session stays resumable. Heartbeats
still in flight on the dropped zombie socket are ignored. On release the
session must RESUME within the time it was held plus 1 s plus two heartbeat
intervals. That grace covers a client released between attempts that is still
in its backoff: with a backoff that starts at 1 s and doubles (DiscordGo), the
gap never exceeds the time already held plus 1 s, whatever the HELLO deadline.
The RESUME re-arms the normal heartbeat timeout. A client that does not RESUME
within the grace loses the session (`session_lost`). The replay buffer
keeps the last 100 dispatches. If more are generated during the hold, the
RESUME gets op 9 `d: false` and `resume_rejected` records it. The status
stays `awaiting_resume` because the session itself is kept: a RESUME with an
unavailable cursor never ends a session. The client then re-IDENTIFYs, and
the old session becomes `session_lost` when its grace ends. Records are
retained until 120 s after that grace, so the outcome is always observable.

**When the hold starts and ends.**

| Event                                                                | Effect                                                                                                                       |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Zombie ends by `client_close`, `reconnect` or `end`                  | `status: "reconnect_held"`, `reconnect_hold` starts. `ttl`, `resume`, `session_removed` and cancellation never start a hold. |
| `POST …/:id/release-reconnect` (or by key)                           | `released_by: "release"`, status `awaiting_resume`; waiting connections get HELLO, deferred RESUMEs proceed.                |
| `reconnect_hold_ttl_ms` elapses                                      | Auto-release, `released_by: "ttl"`.                                                                                          |
| The session is removed (e.g. a forced invalidation)                  | `released_by: "session_removed"`, status `session_lost`; waiting connections get HELLO and their RESUME answers op 9.       |
| DELETE, `/_test/reset`, setup deletion, guild deletion, the bot leaving or being removed from the guild, Gateway shutdown | Released (`released_by: "canceled"`), then the record retires. A client is never left blocked.                                  |

State machine with `hold_reconnect: true`:

```text
zombie ──client_close / reconnect / end──▶ reconnect_held ──release / hold TTL──▶ awaiting_resume ──RESUME──▶ resumed
   │                                            │                                       │
   └──ttl──▶ awaiting_resume                    └──session removed──▶ session_lost       └──session removed──▶ session_lost
```

Without `hold_reconnect` the record never enters `reconnect_held` and
`reconnect_hold` stays `null`; behavior is unchanged.

### `POST /_test/gateway-zombie-connections/:id/release-reconnect` — Release the hold

Body `{}`. Returns `200` with the record: the hold is released if it is
active. If the hold already ended (released, auto-released, session removed),
the release is idempotent and returns the record unchanged; check
`reconnect_hold.released_by`. `409` `INVALID_STATE` when nothing is or was
held: the record has no `hold_reconnect`, the zombie has not ended yet, or
it ended without a hold (`ttl`, `resume`, `session_removed`).
`404` when unknown or retired, and `400` for a missing or nonempty body.

`POST /_test/gateway-zombie-connections/by-key/:key/release-reconnect?bot_id=…&guild_id=…&session_id=…`
does the same, addressed by the exact owner (each field exactly once; `400`
otherwise; `404` for an unknown, retired, tombstoned or wrong-scope key).

### Consumer recipe: hold the reconnect after detection

```typescript
const key = `zombie-${crypto.randomUUID()}`
const scope = new URLSearchParams({ bot_id: botId, guild_id: guildId, session_id: sessionId })
const record = `${base}/_test/gateway-zombie-connections/by-key/${key}`
await fetch(`${base}/_test/gateway-zombie-connections`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    ownership_key: key,
    bot_id: botId,
    guild_id: guildId,
    session_id: sessionId,
    hold_reconnect: true,
    reconnect_hold_ttl_ms: 240_000,
  }),
})
try {
  // 1. Wait until the client detected the zombie and its reconnect is blocked.
  let zombie = await (await fetch(`${record}?${scope}`)).json()
  while ((zombie.reconnect_hold?.attempts ?? 0) < 1) {
    zombie = await (await fetch(`${record}?${scope}&wait_ms=30000`)).json()
  }
  // 2. The client is down (e.g. DiscordGo DataReady == false): do the work,
  //    e.g. wait for a periodic tick that must be skipped.
  // 3. Release: the waiting connection gets HELLO and RESUMEs at once.
  await fetch(`${record}/release-reconnect?${scope}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  zombie = await (await fetch(`${record}?${scope}&wait_ms=30000`)).json()
  // zombie.status === 'resumed'; zombie.resume.replayed covers every dispatch
  // buffered during the zombie and the hold, with original sequences.
} finally {
  await fetch(`${record}?${scope}`, { method: 'DELETE' }) // releases any hold
}
```

Inspect first, then long-poll: a `wait_ms` GET returns on the next change, so a
condition that already holds is only seen without waiting.

### Record

```json
{
  "id": "1d7c…",
  "ownership_key": "zombie-0b8a7d6e",
  "bot_id": "111111111111111111",
  "guild_id": "222222222222222222",
  "session_id": "0123456789abcdef0123456789abcdef",
  "status": "resumed",
  "ttl_ms": 180000,
  "hold_reconnect": true,
  "reconnect_hold_ttl_ms": 180000,
  "sequence": 12,
  "started_at": 1791936000000,
  "zombie_expires_at": 1791936180000,
  "expires_at": 1791936202500,
  "last_ack_at": 1791935990000,
  "heartbeats_unacknowledged": 1,
  "last_heartbeat_at": 1791936031250,
  "last_heartbeat_sequence": 12,
  "dispatches_withheld": {
    "count": 2,
    "first_sequence": 13,
    "last_sequence": 14
  },
  "ended_at": 1791936082500,
  "ended_by": "client_close",
  "close": { "at": 1791936082500, "code": 1012, "initiated_by": "client" },
  "resume": {
    "at": 1791936083100,
    "client_sequence": 12,
    "replayed": { "count": 2, "first_sequence": 13, "last_sequence": 14 },
    "resumed_sequence": 15
  },
  "session_removed_at": null,
  "resume_rejected": null,
  "reconnect_hold": {
    "held_since": 1791936082500,
    "expires_at": 1791936262500,
    "attempts": 2,
    "last_attempt_at": 1791936129500,
    "pending": 0,
    "released_at": 1791936150000,
    "released_by": "release"
  }
}
```

- `status`: `zombie` → `awaiting_resume` → `resumed`, or `session_lost` if
  the session was removed (heartbeat timeout, a rejected RESUME, re-IDENTIFY)
  before a successful RESUME. With `hold_reconnect`, `reconnect_held` comes
  between `zombie` and `awaiting_resume` (see the state machine above).
- `hold_reconnect`, `reconnect_hold_ttl_ms`: the request's options
  (`reconnect_hold_ttl_ms` is `null` without a hold).
- `reconnect_hold`: `null` until a hold starts. `held_since`/`expires_at`
  bound the hold. `attempts` counts what the hold blocked: connections on the
  resume URL left without HELLO, plus RESUMEs deferred on other connections.
  `attempts >= 1` proves the client is really waiting. `last_attempt_at` is
  the latest one. `pending` is how many blocked connections are still open (a
  release reaches them at once). `released_at`/`released_by` (`release`,
  `ttl`, `session_removed`, `canceled`) are set when the hold ends.
- `sequence`: server high-water mark when the zombie started.
- `last_ack_at`: when the last HEARTBEAT_ACK was written to this session
  before the zombie started (`null` if none). Nothing is ACKed afterwards.
- `heartbeats_unacknowledged`, `last_heartbeat_at`,
  `last_heartbeat_sequence`: heartbeats received during the zombie and the
  client's reported sequence (`d`), which stays at its last received
  dispatch.
- `dispatches_withheld`: dispatches sequenced for the session but not
  written while it was silenced. Dispatches generated after the socket
  closed are buffered too, but are not counted here; `resume.replayed`
  covers both.
- `close.at - started_at` is the detection delay as seen by the server, and
  `close.at - last_ack_at` is the time since the client's last ACK.
- `resume`: the successful RESUME's cursor, the replayed sequence range and
  RESUMED's sequence.
- `resume_rejected`: `{ at, client_sequence }` of the latest RESUME of the
  session, received after the zombie ended, that was answered with op 9
  `d: false` because its cursor could not be replayed (e.g. more than 100
  dispatches were buffered). `null` otherwise. A forced rejection
  ([`trigger: "resume"`](#failed-resume-trigger-resume)) is recorded by that
  control instead.
- `expires_at`: retirement time. Evidence is retained for 120 s after the
  zombie ended, or 120 s after `zombie_expires_at` while still active. While
  the reconnect is held, it is 120 s after `reconnect_hold.expires_at`. After
  the release, it is 120 s after the session's RESUME grace ends.

### Inspect, wait, recover and cancel

- `GET /_test/gateway-zombie-connections/:id[?wait_ms=0..30000]`: with
  `wait_ms`, holds until `status` is `resumed` or `session_lost`, the
  `reconnect_hold` changes (the hold starts, blocks an attempt, a blocked
  connection closes, or the hold is released), `resume_rejected` is set, or
  the record retires. It then
  returns `200`, or `404` once retired. At most 64
  concurrent waits (`429`). Responses use `Cache-Control: no-store`.
- `GET /_test/gateway-zombie-connections/by-key/:key?bot_id=…&guild_id=…&session_id=…[&wait_ms=…]`:
  the same, addressed by the exact owner (each field exactly once; `400`
  otherwise).
- `DELETE /_test/gateway-zombie-connections/:id`: ends an active zombie
  (drops the socket with `4000`) or releases an active reconnect hold (blocked
  connections get HELLO) and retires the record; `204`/`404`.
- `DELETE /_test/gateway-zombie-connections/by-key/:key?bot_id=…&guild_id=…&session_id=…`:
  retires the keyed record, or tombstones an unused key in a valid scope so a
  delayed POST returns `409` and silences nothing.

Records are in memory and cleared by `/_test/reset` (all, or the matching
setup token), `DELETE /_test/setup/:token`, deleting the scoped guild and
Gateway shutdown. A library's real detection delay applies, so allow for it
in test timeouts (or shorten it with `GATEWAY_HEARTBEAT_INTERVAL_MS`) and use
`wait_ms` rather than sleeps. Focused real HTTP/WS coverage is in
`src/gateway/connection-faults.test.ts`,
`src/gateway/zombie-reconnect-hold.test.ts` and
`src/gateway/heartbeat-interval.test.ts`.

---

## Simulated guild outage (`GUILD_DELETE` unavailable → `GUILD_CREATE`)

`/_test/gateway-guild-outages` makes one guild temporarily unavailable to one
bot setup, the way a Discord outage does, without removing the bot from the
guild. Use it to test code that pauses work while a guild is unavailable and
reconciles state from the fresh snapshot sent when the guild recovers. These
Fauxcord-only, unauthenticated routes have no Discord OpenAPI manifest
entries.

### Discord behavior modeled

From the official Gateway documentation
([Gateway Events](https://discord.com/developers/docs/events/gateway-events),
[Guild Availability](https://discord.com/developers/docs/events/gateway#guild-availability),
[Unavailable Guild object](https://discord.com/developers/docs/resources/guild#unavailable-guild-object)):

- **Guild Delete** is "sent when a guild becomes or was already unavailable
  due to an outage, or when the user leaves or is removed from a guild … If
  the `unavailable` field is not set, the user was removed from the guild."
  The payload is an Unavailable Guild object, `{ "id": "…", "unavailable": true }`.
- **Guild Create** is sent "when a Guild becomes available again to the
  client", with the full guild object plus Gateway extra fields
  (`members`, `channels`, `voice_states`, …).
- On connect, **Ready** lists every guild as an Unavailable Guild object, and
  "Guilds that are unavailable due to an outage will send a Guild Delete
  event" instead of the lazy-load Guild Create. The same section also says
  "During an outage, the guild object in scenarios 1 and 3 may be marked as
  unavailable", i.e. the lazy-load Guild Create itself may carry the
  unavailable guild object `{ "id": "…", "unavailable": true }`. Discord
  confirmed that this Guild Create variant is intended
  ([discord-api-docs#5054](https://github.com/discord/discord-api-docs/issues/5054)).
  Both variants occur on the real Gateway, so `identify_dispatch` selects
  which one Fauxcord sends.

Discord does not document event delivery for an unavailable guild beyond the
fact that its state arrives through the recovery Guild Create. Fauxcord models
it as silence: the client cannot see the guild, so no dispatch of it is
delivered, and changes made meanwhile are visible only in the recovery
snapshot.

| Phase | What connected sessions of the setup receive |
| ----- | -------------------------------------------- |
| Start | `GUILD_DELETE` `{ "id": guild_id, "unavailable": true }`, normally sequenced and stored in the RESUME replay buffer. |
| Unavailable | Nothing for that guild except `GUILD_DELETE` and the IDENTIFY-time unavailable `GUILD_CREATE` stub. Every other dispatch whose `guild_id` (or `id` for `GUILD_CREATE`/`GUILD_UPDATE`/`GUILD_DELETE`) is the guild — voice states, members, messages, reactions, channels, roles, interactions, … — is dropped **before sequencing**: it consumes no sequence number, is never added to the replay buffer and is never delivered later. Fixtures and REST still change and persist state. |
| IDENTIFY during the outage | `READY` lists the guild as `{ "id": guild_id, "unavailable": true }` (as every guild). Instead of the full `GUILD_CREATE`, the session receives the unavailable stub `{ "id": guild_id, "unavailable": true }` in `READY` guild order: as `GUILD_DELETE` by default, or as `GUILD_CREATE` with `identify_dispatch: "guild_create"`. Other guilds get their full `GUILD_CREATE`. |
| RESUME during the outage | Replays the outage `GUILD_DELETE` if the client had not seen it, and other guilds' events; never a suppressed event. The guild stays unavailable. |
| End | Suppression stops, then `GUILD_CREATE` with the full **current** snapshot (the same builder as the IDENTIFY snapshot: members, channels, `voice_states`, and the member objects of users in voice) is sent to every registered session of the setup. Later events flow normally. |

Scope details:

- An outage affects exactly one guild and the sessions of the bot setup that
  owns it (sessions of that bot ID identified with that setup's token).
  Other guilds of the same bot, other bots and other setups are unaffected.
- `GUILD_DELETE`/`GUILD_CREATE` require the `Guilds` intent; sessions without
  it receive neither, but dispatches of the guild are still suppressed for
  them.
- "Registered sessions" include sessions whose socket dropped and that await
  RESUME: their frames are reported with `transport: "buffered"` and replayed
  on RESUME.
- **REST keeps working** for the guild during an outage. Discord documents no
  REST behavior for unavailable guilds, and bots normally keep issuing REST
  calls. To simulate failing REST calls as well, combine the outage with
  [`POST /_test/rest-faults`](#post-_testrest-faults--fail-bounded-exact-rest-attempts).
- Envelopes already captured (held) by `/_test/gateway-event-controls` before
  the outage were sequenced before it; an explicit release or replay delivers
  them as requested.
- A session forced to re-IDENTIFY through
  `/_test/gateway-session-invalidations` during an outage is `complete` once
  READY and the `GUILD_CREATE` of every **available** guild were sent; the
  attempt lists outage guilds in `unavailable_guild_ids`.

### `POST /_test/gateway-guild-outages` — Start an outage

```json
{
  "ownership_key": "outage-0b8a7d6e",
  "bot_id": "111111111111111111",
  "guild_id": "222222222222222222",
  "ttl_ms": 60000,
  "identify_dispatch": "guild_delete"
}
```

| Field           | Required | Meaning                                                                                                     |
| --------------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `ownership_key` | —        | Optional opaque key chosen **before** sending, `[A-Za-z0-9_-]{1,128}`; enables idempotent retries and by-key routes. |
| `bot_id`        | ✅       | Registered bot user ID (1–20 digit snowflake).                                                              |
| `guild_id`      | ✅       | A guild owned by that bot's setup.                                                                          |
| `ttl_ms`        | —        | Maximum outage duration, integer `1`–`600000`, default `60000`. On expiry the outage **ends with the recovery `GUILD_CREATE`** (`ended_by: "ttl"`). |
| `identify_dispatch` | —    | `"guild_delete"` (default) or `"guild_create"`: which event carries the unavailable stub for sessions that IDENTIFY during the outage. Sessions live at the start always get `GUILD_DELETE`. |

Responses:

- `201` with the outage object below. A retry with the same key, owner,
  `ttl_ms` and `identify_dispatch` returns the existing record (`201`) without dispatching again.
- `400` for malformed JSON, a non-object, unknown fields, or invalid IDs, key,
  TTL or `identify_dispatch`; `413` for bodies over 16 KiB.
- `404` `UNKNOWN_SCOPE` when the guild does not exist or is not owned by that
  bot's setup.
- `409` `BUSY` when the guild already has an active outage for that setup.
- `409` `CONFLICT` when the key is reserved with a different owner,
  `ttl_ms` or `identify_dispatch`, was closed by DELETE, or its record retired.
- `429` `LIMIT` when 32 outage records (active plus recovered-but-retained)
  or 4096 key reservations exist in this Gateway instance.

The `GUILD_DELETE` frames are written synchronously before the response, and
suppression is active once it returns. Starting an outage with no connected
session is allowed; it then only affects later IDENTIFYs.

### Outage object

```json
{
  "id": "4f0c3c87-5b1e-4f7e-a0e3-7f5bb8a8f0d1",
  "ownership_key": "outage-0b8a7d6e",
  "bot_id": "111111111111111111",
  "guild_id": "222222222222222222",
  "status": "recovered",
  "ended_by": "request",
  "ttl_ms": 60000,
  "identify_dispatch": "guild_delete",
  "started_at": 1791936000000,
  "expires_at": 1791936060000,
  "ended_at": 1791936012000,
  "retained_until": 1791936132000,
  "recovery_snapshot": true,
  "guild_deletes": [
    {
      "session_id": "0123456789abcdef0123456789abcdef",
      "trigger": "outage_start",
      "sequence": 42,
      "ready_sequence": null,
      "transport": "sent",
      "dispatched_at": 1791936000001
    },
    {
      "session_id": "fedcba9876543210fedcba9876543210",
      "trigger": "identify",
      "sequence": 3,
      "ready_sequence": 1,
      "transport": "sent",
      "dispatched_at": 1791936005000
    }
  ],
  "guild_deletes_skipped": 0,
  "guild_creates": [
    {
      "session_id": "0123456789abcdef0123456789abcdef",
      "trigger": "recovery",
      "unavailable": false,
      "sequence": 43,
      "ready_sequence": null,
      "transport": "sent",
      "dispatched_at": 1791936012001,
      "member_count": 2,
      "channel_count": 3,
      "voice_states": [
        {
          "user_id": "888888888888888888",
          "channel_id": "555555555555555555",
          "session_id": "c0ffee...",
          "self_stream": true,
          "self_video": false
        }
      ],
      "voice_states_total": 1
    }
  ],
  "guild_creates_skipped": 0,
  "suppressed_dispatches": 3,
  "suppressed_by_event": { "VOICE_STATE_UPDATE": 2, "MESSAGE_CREATE": 1 }
}
```

- `status`: `unavailable` while active, `recovered` after it ended;
  `ended_by` is `request` (end route, DELETE or reset) or `ttl`.
- `recovery_snapshot`: `null` while active; `true` when recovery dispatched a
  `GUILD_CREATE` snapshot to at least one session; `false` when it dispatched
  none, either because the guild no longer belongs to the setup at recovery
  time (for example another `/_test/setup` reused the guild ID; nothing is sent
  to the original setup's sessions) or because no registered session of the
  setup holds the `Guilds` intent. A session that IDENTIFYs after recovery
  receives the ordinary full `GUILD_CREATE`.
- `started_at`/`ended_at`/`dispatched_at` are server epoch milliseconds;
  `expires_at` is when the TTL would end the outage.
- `guild_deletes`: one entry per written outage `GUILD_DELETE`, with the
  session, its Gateway `sequence`, and the trigger: `outage_start` for
  sessions registered at start, `identify` for sessions that IDENTIFYed during
  the outage (with that session's READY sequence in `ready_sequence`).
- `guild_creates`: one entry per written `GUILD_CREATE` of this outage, with
  its sequence and trigger: `recovery` for the full snapshot (`unavailable:
  false`, with a bounded summary: 100 voice states each, full count in
  `voice_states_total`), or `identify` for the unavailable stub sent to a
  session that IDENTIFYed during the outage with `identify_dispatch:
  "guild_create"` (`unavailable: true`, its READY sequence in
  `ready_sequence`, empty summary).
- At most 50 entries are retained per list; further frames are still sent and
  counted in `guild_deletes_skipped`/`guild_creates_skipped`.
- `transport` is the server socket write (`queued`, `sent`, `failed`, or
  `buffered` for a session awaiting RESUME), not client processing.
- `suppressed_dispatches`/`suppressed_by_event`: per-session dispatches of the
  guild dropped during the outage (one event fanned out to two sessions
  counts twice).

Correlate with the bot per `session_id`. The outage starts for a session at
its outage signal: its `guild_deletes[]` entry (`outage_start`, or `identify`
in the default mode), or, with `identify_dispatch: "guild_create"`, its
`guild_creates[]` entry with `trigger: "identify"` (`unavailable: true`). It
ends at its `guild_creates[]` entry with `trigger: "recovery"`. Never treat an
`identify` stub as the recovery. Events of other guilds in between carry
sequences between the two.

### `POST /_test/gateway-guild-outages/:id/end` — End an outage

Ends an active outage: suppression stops and the recovery `GUILD_CREATE` is
written to every registered session of the setup with the `Guilds` intent.
Returns `200` with the outage object. Ending an already recovered outage
returns `200` with the unchanged record and sends nothing. `404` for an
unknown or retired ID; the route takes no query parameters (`400`).
Recovered records stay inspectable for 120 seconds (`retained_until`) and then
retire.

### `GET /_test/gateway-guild-outages/:id` — Inspect and wait

Returns `200` with the outage object or `404`. Optional `wait_ms` (integer
`0`–`30000`, no other query fields) holds the response until the outage has
recovered and every recorded frame finished its write (no `queued`
transport), or the record retires, then returns the current record (which may
still be `unavailable` when the wait elapsed). At most 64 concurrent waits per
Gateway instance (`429`). Responses use `Cache-Control: no-store`.

### By-key routes

```text
GET    /_test/gateway-guild-outages/by-key/:key?bot_id=:bot&guild_id=:guild[&wait_ms=10000]
POST   /_test/gateway-guild-outages/by-key/:key/end?bot_id=:bot&guild_id=:guild
DELETE /_test/gateway-guild-outages/by-key/:key?bot_id=:bot&guild_id=:guild
```

Each scope field is required exactly once; unknown or duplicate fields return
`400`. GET and end behave like their ID forms and return `404` for an unknown,
retired, tombstoned or wrong-scope key. DELETE returns `204`: for an applied
key it ends an active outage (with recovery) and discards the record; for an
**unused** key it reserves a tombstone when the bot owns the guild (`404`
otherwise), so a delayed POST with that key returns `409` and starts nothing.

### `DELETE /_test/gateway-guild-outages/:id` — End and discard

Ends the outage if it is still active — sending the recovery `GUILD_CREATE`,
so a connected client is never left with a permanently unavailable guild —
and discards the record (`204`; `404` if unknown). Use it in test cleanup.

### Lifecycle

| Event | Effect |
| ----- | ------ |
| TTL expiry | Ends the outage with the recovery `GUILD_CREATE`; record retained 120 s. |
| End route | Same, `ended_by: "request"`. |
| DELETE (by ID or key) | Ends an active outage with recovery, then discards the record. |
| `POST /_test/reset` (all, or matching `token`) | Runs after the data reset: active outages recover with a snapshot of the reset state, then records are discarded. |
| The bot loses the guild (`DELETE /guilds/:id`, leaving via `DELETE /users/@me/guilds/:id`, kicking or banning the bot) | The removal `GUILD_DELETE` (`{ "id": guild_id }` without `unavailable`) is still delivered — it is never suppressed — then the record is discarded without a recovery `GUILD_CREATE`. A detached guild accepts no new outage. |
| `DELETE /_test/setup/:token` | Records are discarded **without** dispatching (the guild no longer exists). |
| Gateway shutdown | Records are discarded without dispatching. |

Discarded records answer `404`; their keys stay closed. Records and
reservations are in memory only.

### Harness flow without sleeps

```typescript
const key = `outage-${crypto.randomUUID()}`
const query = new URLSearchParams({ bot_id: botId, guild_id: guildId })
const address = `${base}/_test/gateway-guild-outages/by-key/${key}?${query}`
try {
  await fetch(`${base}/_test/gateway-guild-outages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ownership_key: key, bot_id: botId, guild_id: guildId }),
  }).catch(() => undefined) // a lost response is recovered by the GET below
  const started = await fetch(address)
  if (started.status !== 200) throw new Error('Outage was not started')
  // Assert the bot paused work for the guild; change voice states through
  // fixtures (they persist but are not dispatched).
  const ended = await fetch(
    `${base}/_test/gateway-guild-outages/by-key/${key}/end?${query}`,
    { method: 'POST' }
  )
  const outage = await ended.json()
  // Per session_id, the outage signal (guild_deletes, or a guild_creates
  // entry with trigger "identify") and the guild_creates entry with
  // trigger "recovery" bracket the outage; assert the bot reconciled it.
} finally {
  const cleanup = await fetch(address, { method: 'DELETE' })
  if (cleanup.status !== 204) throw new Error(`Cleanup: ${cleanup.status}`)
}
```

Focused real HTTP/WS coverage is in `src/gateway/guild-outages.test.ts`.

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

## Change channel visibility through Discord REST

Use `PUT /api/v10/channels/:channelId/permissions/:overwriteId` with the bot's
`Authorization` header to add or replace a role (`type: 0`) or member (`type: 1`)
overwrite. `DELETE` at the same path removes it. These endpoints also accept the
`/api` and bare prefixes and return an empty `204` response on success.

For example, deny `VIEW_CHANNEL` to `@everyone` (whose role ID is the guild ID)
to model a private channel:

```bash
curl -X PUT http://localhost:3000/api/v10/channels/333333333333333333/permissions/222222222222222222 \
  -H 'Authorization: Bot testtoken' \
  -H 'Content-Type: application/json' \
  -d '{"type":0,"allow":"0","deny":"1024"}'
```

Connect the guild's registered bot with the Guilds intent and consume READY and
initial GUILD_CREATE before making changes. Each successful PUT and each DELETE
that removes an overwrite queues one native `CHANNEL_UPDATE` with the complete
current channel object, including `guild_id` and all remaining
`permission_overwrites`. The payload matches `GET /channels/:channelId` and lets
Discord libraries refresh their channel permission caches. Omitted `allow` or
`deny` values default to `"0"`; replacing an overwrite does not duplicate it.
Deleting that guild overwrite restores the channel's fixture permissions.

Delivery uses ordinary Gateway sequencing and replay buffers. Only sessions of
that guild's registered bot in this database using the same setup token and the
Guilds intent receive these overwrite updates. Other bots, databases, and channels
retain their state. A missing overwrite DELETE returns `204` with
no event. Invalid payloads (`400`), unknown channels (`404`), and rejected
authentication (`401`) change no data and queue no update.

Emulator limitations: these overwrite endpoints do not enforce `MANAGE_ROLES`
or channel visibility. Their REST authentication permits access across guild setups;
Gateway delivery follows the guild's registered bot rather than the request's
bot token. Permission overwrite dispatches apply to guild channels.

## Exercise actual message-send permissions

`POST /channels/:channelId/messages` (also `/api` and `/api/v10`) checks the
authenticated bot's persisted guild permissions. This uses the existing roles,
member roles and overwrites; no injected REST fault is needed. It applies
`@everyone` base permissions, the union of assigned guild role permissions,
then everyone, combined role, and member overwrites. At each overwrite stage,
denies apply before allows. Role positions do not affect these calculations.
Bitfields use arbitrary-precision integers and are serialized as decimal strings.
See [Discord's permission semantics](https://docs.discord.com/developers/topics/permissions).

Guild owners and members with guild-level `ADMINISTRATOR` bypass these checks.
An `ADMINISTRATOR` bit in a channel overwrite does not grant that bypass.
For a meaningful denial test, register a human using `POST /_test/users`, then
pass their ID as `guilds[].owner_id` to `POST /_test/setup`. The default setup
bot is the owner and therefore bypasses even a member-specific denial. The
human-owner setup already adds both the bot and owner as guild members and
creates `@everyone` with the existing default permissions.

For example, deny sending to the non-owner bot, using its user ID:

```bash
curl -X PUT http://localhost:3000/api/v10/channels/333333333333333333/permissions/111111111111111111 \
  -H 'Authorization: Bot testtoken' \
  -H 'Content-Type: application/json' \
  -d '{"type":1,"allow":"0","deny":"2048"}'
```

Missing guild membership or `VIEW_CHANNEL` (`1024`) returns HTTP `403`, code
`50001` (`Missing Access`). (Removing the bot itself through REST — leave, kick or ban — only
detaches it from the surviving guild, so it has no membership or owner shortcut and its later sends
return `403`/`50001`, not `404`; deleting the guild with `DELETE /guilds/:guildId` makes them
return `404`. See
[Remove a guild from the bot](#remove-a-guild-from-the-bot-through-discord-rest-guild_delete).) Missing `SEND_MESSAGES` (`2048`) returns HTTP `403`,
code `50013` (`Missing Permissions`). A nonempty explicit `embeds` array also
requires `EMBED_LINKS` (`16384`), including embed-only messages and messages
with `SUPPRESS_EMBEDS`. Omitted, `null`, or empty embeds and plain URL content
do not require that bit. Active member timeouts deny sending with `50013`;
expired/cleared timeouts restore normal permissions. Owners and administrators
are exempt from timeouts.

Supported guild targets are text (`0`), voice text chat (`2`), announcement
(`5`), and stage text chat (`13`). DM (`1`) and group DM (`3`) sends retain their
existing behavior without guild checks. Webhook execution and human message
fixture controls retain their separate semantics. Category (`4`), directory
(`14`), forum (`15`), media (`16`), and unknown types return HTTP `400`, code
`50024`. Thread sends (`10`, `11`, `12`) are explicitly unsupported and also
return `400/50024`: their parent permissions, `SEND_MESSAGES_IN_THREADS`, private
membership and archive lifecycle are not modeled by this send endpoint.

Denied requests create no message, embed, attachment or poll records, do not
advance `last_message_id`, and produce no `MESSAGE_CREATE` or replay entry.
Permissions are re-read after body parsing and again immediately before the
synchronous message transaction, including after asynchronous file preparation.
Uploads prepared before a revocation or channel deletion are removed without
being published. Restoring membership, roles or overwrites takes effect on the
next send. Concurrent sends evaluate their own author and channel; persisted
message-create events stay in their originating server database.

`POST /_test/reset` retains guild membership, roles and overwrites, so it does
not restore a denied permission. Delete an overwrite through Discord REST to
restore its inherited permissions, or delete/recreate the setup to clear its
guild fixtures. There is no queued permission state to cancel. This enforcement
is scoped to channel message creation: it does not add permission checks to
message reads, edits, deletes, or other Discord endpoints, and does not yet
enforce feature-specific send permissions such as TTS, attachments, replies,
stickers or polls. It supplies Fauxcord prerequisites for bot integration tests;
the bot harness and end-to-end handler coverage remain downstream work.

## Server voice moderation through Modify Guild Member

`PATCH /guilds/:guildId/members/:userId` (also `/api` and `/api/v10`) applies
Discord's voice moderation fields, see
[Modify Guild Member](https://docs.discord.com/developers/resources/guild#modify-guild-member):

| Field        | Effect                                                                                     | Required permission                                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `mute`       | Server mute (`true`) or unmute (`false`).                                                  | `MUTE_MEMBERS` (`4194304`) in the target's current channel                                                                      |
| `deaf`       | Server deafen (`true`) or undeafen (`false`).                                              | `DEAFEN_MEMBERS` (`8388608`) in the target's current channel                                                                    |
| `channel_id` | Move to another voice (`2`) or stage (`13`) channel of the same guild; `null` disconnects. | `MOVE_MEMBERS` (`16777216`) in the current channel; a different destination also needs `CONNECT` (`1048576`) and `MOVE_MEMBERS` |

Connect the member first with
[`PATCH /_test/guilds/:guildId/voice-states/:userId`](#patch-_testguildsguildidvoice-statesuserid--prepare-a-voice-state).
A successful request returns `200` with the updated member (or the existing
empty `204` when `roles` and `mute` are combined without a timeout, the spec's
documented alternative success response), persists
`guild_members.mute`/`deaf` and the voice state together, and then publishes
`GUILD_MEMBER_UPDATE` followed by one `VOICE_STATE_UPDATE` if the voice state
changed. The voice event goes through the shared voice-state publisher, so
`GuildVoiceStates` intent filtering, sequencing, the replay buffer and
[capture/hold/release/replay](#scoped-gateway-capture-hold-release-and-replay)
behave exactly like fixture-driven voice events. Combined fields (for example
`{"mute":true,"nick":"Quiet"}`) produce a single voice event whose embedded
member already contains every change. Re-sending an unchanged flag emits only
`GUILD_MEMBER_UPDATE`.

- **Move**: keeps the voice `session_id`, `self_mute`, `self_deaf` and
  `self_video`; ends Go Live (`self_stream: false`); clears
  `request_to_speak_timestamp`; and sets `suppress` to `true` for a stage
  destination (audience) or `false` for a voice channel. Moving to the current
  channel changes nothing.
- **Disconnect** (`"channel_id": null`): same semantics as the fixture
  disconnect. `channel_id` becomes `null` with the previous `session_id`;
  streaming, video and request-to-speak are cleared; server mute/deaf remain on
  the member and apply again on the next join.

Errors (checked in this order; rejected requests write nothing and emit no
event, even for other fields in the same payload):

1. Unknown guild: `404`, code `10004`.
2. Non-boolean `mute`/`deaf` or a non-snowflake-string `channel_id`: `400`,
   code `50035` (`BASE_TYPE_BOOLEAN` / `NUMBER_TYPE_COERCE`).
3. Unknown role or member: `404` (`10011`, `10007`).
4. Target not connected to voice (no voice state, or a disconnected one) with
   any non-null `mute`/`deaf` or any `channel_id`, including `null`: `400`, code
   `40032` (`Target user is not connected to voice.`). `mute: null` and
   `deaf: null` are no-ops and do not require a connection.
5. Destination that does not exist or belongs to another guild: `404`, code
   `10003`. A non-voice/stage destination: `400`, code `50024`.
6. Missing permission: `403`, code `50013` (`Missing Permissions`). An OAuth2
   Bearer token cannot moderate voice and always receives this error for
   voice fields.

Permissions are resolved like
[message-send permissions](#exercise-actual-message-send-permissions): `@everyone`
and assigned roles, then everyone, role and member overwrites of the relevant
channel. Missing `VIEW_CHANNEL` or `CONNECT` in that channel implicitly denies
every voice moderation permission there (Discord's
[implicit permissions](https://docs.discord.com/developers/topics/permissions#implicit-permissions)).
The guild owner and members with guild-level `ADMINISTRATOR` bypass all checks.
**The default `POST /_test/setup` bot owns its guilds, so existing setups need no
extra grants.** If `guilds[].owner_id` selects a human owner (or another setup
takes over ownership), grant the bot a role with the bits above (or
`ADMINISTRATOR`) through `POST /guilds/:guildId/roles` and
`PUT /guilds/:guildId/members/:botId/roles/:roleId`; the default `@everyone`
permissions (`1071698660929`) include `VIEW_CHANNEL` and `CONNECT` but none of
the moderation bits. Only the voice fields are permission-checked; `nick`,
`roles` and `communication_disabled_until` keep their unchecked behavior. With
`DISABLE_AUTH=true` and an unregistered token, the dummy bot has no stored
permissions and skips these checks.

REST fault controls for `PATCH /guilds/:guildId/members/:userId` still run
first: an injected failure writes nothing and emits no voice event, and a later
retry applies normally. This endpoint records no audit-log entries and ignores
`X-Audit-Log-Reason`, as before.

`PATCH /guilds/:guildId/members/@me` (Modify Current Member) does not accept
voice fields on Discord. Fauxcord ignores `mute`, `deaf` and `channel_id` there,
like other unknown fields, and only applies `nick`. Target the bot's own user ID
on the route above to moderate the bot itself.

Discord does not document several details; Fauxcord's choices:

- Error precedence (`40032` before channel and permission errors), the codes
  for invalid destinations (`10003`/`50024`), and requiring `MOVE_MEMBERS` in
  both source and destination.
- Gateway order: `GUILD_MEMBER_UPDATE` is published before
  `VOICE_STATE_UPDATE`.
- Move side effects (Go Live ends, stage destinations start suppressed
  regardless of the target's stage moderator status).
- Role hierarchy, timeouts of the acting bot, channel user limits and
  `PRIORITY_SPEAKER` are not modeled for voice moderation.

---

## Remove a guild from the bot through Discord REST (`GUILD_DELETE`)

A bot loses a guild when it leaves, is kicked or banned, or the guild is
deleted. Fauxcord models each of these as real Discord does and sends
`GUILD_DELETE` to every live Gateway session of the guild's bot (same setup
token) that has the `GUILDS` intent:

```json
{ "op": 0, "t": "GUILD_DELETE", "s": 42, "d": { "id": "222222222222222222" } }
```

`d` is an [unavailable guild object](https://discord.com/developers/docs/resources/guild#unavailable-guild-object)
**without** `unavailable`, which is how Discord marks "the user left or was
removed" (`unavailable: true` is reserved for outages; see
[Simulated guild outage](#simulated-guild-outage-guild_delete-unavailable--guild_create)).
If the guild is in a simulated outage, only the removal `GUILD_DELETE` is
delivered; the bot's `GUILD_MEMBER_REMOVE` is an event of the unavailable guild
and is suppressed.

| Path                                                    | Dispatches, in order                                                                               | Guild afterwards |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------- |
| `DELETE /users/@me/guilds/:guildId` (leave)             | bot `VOICE_STATE_UPDATE`¹, `GUILD_MEMBER_REMOVE` for the bot (`GUILD_MEMBERS`), `GUILD_DELETE`     | survives         |
| `DELETE /guilds/:guildId/members/:botId` (kick)         | same as leave                                                                                      | survives         |
| `PUT /guilds/:guildId/bans/:botId` (ban)                | same as leave; the ban is recorded (reason, message deletion window) without `GUILD_BAN_ADD`       | survives         |
| `POST /guilds/:guildId/bulk-ban` with the bot's user ID | other users' ban events, then the same as ban                                                      | survives         |
| `DELETE /guilds/:guildId`                               | `GUILD_DELETE`                                                                                     | **deleted**      |

¹ Only when the bot was connected to a voice or stage channel, as for any
removed member (see
[Member removal disconnects voice](#member-removal-disconnects-voice)).

Fauxcord's only REST actor is the bot itself, so a kick or ban whose target is
the guild's own bot stands in for an administrator removing it. A bulk ban
first bans the other listed users, lists the bot in `banned_users`, and then
detaches the bot. Kicking or banning anyone else is unchanged.

Discord documents `GUILD_MEMBER_REMOVE` for "leave/kick/ban" and both events for
Leave Guild, but not their relative order; Fauxcord sends `GUILD_MEMBER_REMOVE`
first so that nothing for the guild follows `GUILD_DELETE`. Both are ordinary sequenced dispatches retained in the replay
buffer, so a client that was disconnected receives them on `RESUME`.

### Fixture lifetime versus bot membership

Each Fauxcord guild belongs to exactly one setup (`guilds.bot_token`), and that
ownership is the **fixture lifetime**: the guild, its channels, roles, messages,
human memberships, voice states and bans live until the guild is deleted
explicitly (`DELETE /guilds/:guildId`) or its setup is deleted
(`DELETE /_test/setup/:token`); both are destructive and silent for detached
guilds. `POST /_test/reset` is a selective, silent cleanup instead: it keeps
guilds, channels, members, bans and bot registrations (and therefore a
detached guild and its detached state) and only clears posted data, voice
states and control records, for attached and detached guilds alike (as before
this change, it clears voice states of every guild). It neither deletes nor
reattaches a guild the bot left. The bot's
**membership** is separate: leaving, a kick or a ban only deletes the bot's own
membership (and connected voice state), records a ban when applicable, and
detaches the bot from the guild. A real bot leaving does not destroy the
server, so neither does Fauxcord.

After the bot is detached:

- `GET /users/@me/guilds` no longer lists the guild, `GET /guilds/:guildId/members`
  no longer lists the bot, and a later IDENTIFY omits the guild from READY's
  `guilds` and sends no `GUILD_CREATE`.
- **Nothing for the guild is dispatched to any session** any more, regardless
  of the producer (REST, test controls, cross-guild voice displacement): such
  dispatches are dropped before sequencing, so they use no sequence number and
  never enter the replay buffer. A disconnected session that resumes receives
  only what was buffered before the removal, including the removal events.
- Unauthenticated test controls keep working on the surviving fixtures,
  including human voice states (`PATCH /_test/guilds/:guildId/voice-states/:userId`),
  member joins, message and reaction injection. They are just not observable
  by the removed bot. `POST /_test/interactions` for the guild returns `404`
  (`Unknown Guild`/`Unknown Channel`) because the bot cannot receive it.
- Gateway event controls, session-invalidation, zombie-connection and
  outage records scoped to the guild are canceled **after** `GUILD_DELETE` is
  written (held events are discarded, as with any other cancellation) and new
  ones for the guild are rejected as an unknown scope.
- Other bots, other guilds and other setups sharing the same bot user ID
  receive nothing from the removal itself. Unchanged Fauxcord limitation: many
  guild events (messages, channels, roles, members) are broadcast to every
  connected session, not just the owning setup, for attached guilds too; a
  session is only excluded from a guild its own setup was removed from, or
  from a detached guild.
- Leaving a guild the bot already left, or that does not exist or belongs to
  another bot, returns `404` `{"message":"Unknown Guild","code":10004}` and
  dispatches nothing. Kicking the detached bot again returns `404`
  (`Unknown Member`); banning it again is an ordinary idempotent `204`.
- **Rejoin**: `POST /_test/setup` for the existing guild ID (under a new
  token, as setup tokens are unique) reattaches the guild to that setup,
  re-adds the bot as a member, clears a ban of the bot's user ID and sends
  `GUILD_CREATE` with the surviving fixture (channels, members, voice
  states). Later IDENTIFYs list the guild again. The removed setup's sessions
  never see the guild again, and once another setup takes the guild over, its
  Bot token (and OAuth2 credentials linked to it) are denied with `403`
  `Missing Access` on every guild-scoped native REST route (`/guilds/:id…`,
  `/channels/:id…`, `/webhooks/:id…`, `/invites/:code`, `/lobbies/:id…`
  (when linked to a guild channel), `/users/@me/guilds/:id/member`, `/applications/:id/guilds/:id…`; token-based
  webhook execution is unauthenticated and unaffected), even when the new setup
  reuses the same bot user ID. Until a takeover, a detached guild under the
  removed setup keeps the limitations described below (an earlier removal is recorded per
  guild, survives deletion of that setup, and is cleared only when the same
  token lists the guild again or the guild is deleted).

Native REST for a detached guild, and deliberate emulator limitations. Fauxcord
authorizes most guild routes by guild existence only, never by the caller's
membership, so — as before for other bots — a detached bot's token can still
reach those routes (`GET /guilds/:id`, `GET /guilds/:id/members`, channel
edits, `DELETE /guilds/:id`, …); real Discord would answer `403 Missing Access`.
The routes that do model the bot's access answer `403`/`50001` for the
detached bot: sending messages and other permission-resolved calls (the bot has
no membership and loses the owner shortcut), the guild-ownership routes (bulk
ban, incident actions, stage instances, soundboard sound sends, and the
guild-scoped application command and command permission routes, whose stored
registrations survive and are served again after a rejoin), and
`GET /users/@me/guilds` simply omits the guild. Dispatches caused by a
detached bot's REST calls are never delivered. Audit-log response controls,
REST fault controls and page holds scoped to the guild stay registered with
the surviving fixture.

Discord rejects a guild owner leaving its own guild; Fauxcord does not enforce
ownership here (setups default the owner to the bot), so the bot can always
leave.

Test-control cleanup (`DELETE /_test/setup/:token`, `POST /_test/reset`) is
always silent.

---

## REST pagination page holds

Use these controls to pause the **next matching authenticated GET** for a
member or ban page while a harness inspects the importer's previously persisted
page and stops its bot. These controls are separate from `LATENCY_MS`, Gateway
replay, and REST faults. They never change member/ban fixtures or the importer's
checkpoints.

### `POST /_test/rest-page-holds`

```bash
curl -X POST http://localhost:3000/_test/rest-page-holds \
  -H 'Content-Type: application/json' \
  -d '{
    "path": "/guilds/222222222222222222/members",
    "after": "100000000000000001",
    "timeout_ms": 30000
  }'
```

| Field        | Required | Meaning                                                                                                                                              |
| ------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `path`       | yes      | Bare `/guilds/{id}/members` or `/guilds/{id}/bans`, without query parameters. Guild must exist; its owning bot is captured at creation.              |
| `after`      | yes      | Exact decimal string cursor, or `null` to require absence of `after`. `null` and `"0"` are distinct.                                                 |
| `before`     | no       | Ban page's exact decimal string cursor; default `null` requires absence. A non-null `before` requires `after: null`; members cannot select `before`. |
| `timeout_ms` | yes      | Integer from 1 to 60000. Deadline starts at **arming**, so an unused hold also expires.                                                              |

The selector matches GETs through bare, `/api`, and `/api/v10` paths. It requires
the guild's owning Bot token and exact decoded cursor values; duplicate cursor
parameters do not match. `limit` and other query parameters do not select a
hold. Different bots, guilds, routes, and earlier/different cursors proceed
normally, as do test-control and health endpoints. The first matching request
claims the hold atomically. Further matching requests proceed normally, even
while the first is held: this is a one-shot control, not a gate on retries.

Returns `201` with the configuration and status below; invalid selectors return
`400`, an unknown guild returns `404`, and an already armed/holding identical
selector returns `409`. The API does not expose bot credentials.

### `GET /_test/rest-page-holds/{id}`

Returns current status with `Cache-Control: no-store`, or `404` after removal:

```json
{
  "id": "100000000000000099",
  "guild_id": "222222222222222222",
  "path": "/guilds/222222222222222222/members",
  "after": "100000000000000001",
  "before": null,
  "timeout_ms": 30000,
  "state": "holding",
  "arrived": 1,
  "arrived_at": "2026-10-04T12:00:01.000Z",
  "expires_at": "2026-10-04T12:00:30.000Z",
  "finished_at": null
}
```

`state` is `armed`, `holding`, `released`, `timed_out`, or `disconnected`.
`arrived` is 0 or 1 and `arrived_at` records the first matching request reaching
the hold middleware. This proves **request arrival only**. It does not prove
that the importer persisted an earlier page or committed its checkpoint.
`finished_at` is populated when the control disarms. Terminal status is retained
until explicit deletion, reset, scope deletion, or server shutdown.

### Release and removal

- `POST /_test/rest-page-holds/{id}/release` disarms an armed control or resumes a
  held request; returns `200` with retained status (`404` for unknown IDs).
  Repeated release is idempotent and keeps an existing terminal state.
- `DELETE /_test/rest-page-holds/{id}` removes configuration and evidence,
  resuming a held request; returns `204` (`404` for unknown IDs).

After release/removal or timeout, the original request proceeds through normal
REST-fault middleware and native route handling. With no matching fault, the
native handler produces its normal status, body, and headers. It reads current
fixture data at that time; the hold does not snapshot a page.
Page holds run before REST-fault matching. If the released request also matches
an armed page-specific REST fault, it receives that fault and consumes its
attempt then; holding or disconnecting the request alone consumes no fault.
Fault query normalization and exhaustion behavior remain unchanged.
A client disconnect ends the wait and disarms the control as `disconnected`;
reconnecting or restarting that bot cannot reuse a claimed hold. Token-scoped
`POST /_test/reset`, bot setup deletion, and guild deletion remove the affected
controls and unblock requests. A global reset removes all controls. Shutdown
unblocks requests before draining the HTTP server. Controls live only in memory
and cannot survive a Fauxcord restart.

For an import harness such as DSC-837:

1. Arm the exact **next page cursor** before starting the importer.
2. Poll status until `holding` with `arrived: 1`, failing if the bounded deadline
   expires first.
3. Independently inspect the bot application's persisted earlier page and
   checkpoint using the harness's own database observation.
4. Stop that bot and wait for process exit/disconnection. Poll for
   `disconnected`, or explicitly remove the control if the client leaves an
   in-flight connection open.
5. Always delete the control in harness cleanup **before restarting the bot**,
   including if it never reached the selected page. Use a fresh control ID for
   another run. If continuing without stopping, explicitly release instead.

When embedding `buildApp`, call its `shutdownRestPageHolds()` before closing the
HTTP server, then close the database after HTTP requests drain. The production
entry point and `createRealServer()` already use this order.
