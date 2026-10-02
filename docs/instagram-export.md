# Instagram Export Format (as observed)

These notes come from a real "Download your information" JSON export (September 2026). The importer is in `src/importers/instagram/`.

## Common to all files

- **Text is mojibake.** UTF-8 bytes are written as `\u00XX` code points, so `’` arrives as `â\u0080\u0099`. The importer decodes this with `decodeExportText`. `raw` keeps the untouched original.
- **Timestamps:** Likes and Saved use `timestamp`, in Unix **seconds**. Messages use `timestamp_ms`, in **milliseconds**.
- **Empty values:** `""` means "none" (for example `share_text: ""` or `Caption: ""`). The importer never keeps an empty value as data.

## `likes/liked_posts.json` and `saved/saved_posts.json`

Both files have the same shape: an array of `{ timestamp, media: [], label_values: [...], fbid }`.

`label_values` mixes two kinds of entry:

| Entry | Contents |
|---|---|
| `{ label: "URL", value, href }` | Clean post URL: `/p/<shortcode>/` or `/reel/<shortcode>/` |
| `{ label: "Caption", value }` | Post caption. Can appear **twice**, usually identical, sometimes different |
| `{ label: "Title", value: "" }` | Always empty in the sample |
| `{ title: "Hashtags", dict: [{ dict: [{ label: "Name", value }] }] }` | Hashtags, which duplicate the caption |
| `{ title: "Owner", dict: [{ dict: [URL, Name, Username] }] }` | Creator. **Owner `URL` is the creator's external website** (linktr.ee, portfolio), not their Instagram profile |
| `{ title: "Brand partner", dict: [] }` | Always empty in the sample |

- `media` is always `[]`, so the export contains no media.
- `fbid` is unique per entry.
- The export has no timestamp for when the post was *published*.

## `messages/<inbox|message_requests>/<thread>/message_N.json`

`{ participants: [{ name }], messages: [...], title, thread_path, is_still_participant, magic_words }`

Messages are newest first. Each one has `sender_name`, `timestamp_ms` and, optionally, `content`, `share`, `photos` or `reactions`.

- **Post/reel share:** `share: { link, share_text, original_content_owner }`.
  - `link` carries a query string: `/reel/X/?id=<mediaId>_<ownerId>`.
  - `share_text` is the post caption. It matches the Liked caption for the same post.
  - `original_content_owner` is the creator's username.
- **`content` on a share is a placeholder**, not user text:
  - `"You sent an attachment."` when the export owner sent it.
  - `"<Name> sent an attachment."` when someone else did. `<Name>` is only the first word of a multi-word display name (`"Aanchal"` for `sender_name` `"Aanchal Chaurasia"`).
- **Carousel slide share:** `link` is `/p/<shortcode>/?carousel_share_child_media_id=<childMediaId>_<ownerId>`, and `share_text` is `""`. Sharing several slides of one carousel produces one message per slide, all with the same shortcode.
- **Link-only share:** `share: { link }` with no `share_text` or owner. It is mostly `/stories/<user>/<id>`, sometimes `/p/`. When it has real `content`, that is a reply the sender wrote to a story or post. It is conversation, not context for a shared post.
- **External link:** `share: { link: "http://…", share_text }`, for a non-Instagram site.
- **Plain chat messages** have no `share`.

### The user's note

The export has no note field for shares. A share's `content` is only the attachment placeholder. The importer therefore **never sets `MessageContext.userNote`**. Reply text on link-only shares stays in `raw` only.

### Who sent it (`sentByOwner`)

The export only knows the *exporting account*. Placeholders say "You" for that account and use the sender's name for everyone else. The rules, in order:

1. `sender_name` is listed in the `ownerSenderNames` import option → `true`. Use this option for the owner's other accounts, which the export labels as someone else.
2. `content` is `"You sent an attachment."` → `true`.
3. `content` is any other `"<name> sent an attachment."` → `false`. The name does not need to match `sender_name`.
4. No placeholder (for example a link-only share): the result depends on how placeholders elsewhere in the export label that name.
   - Labelled only as the owner → `true`.
   - Labelled only as someone else → `false`.
5. Otherwise it is unset (unknown). This covers names never seen with a placeholder, names labelled both ways, and a missing sender.
