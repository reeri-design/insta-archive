# Design Direction

This document is the visual and interaction constitution for the archive UI.

The product is a personal creative reference archive: a quiet space where a large, messy collection of visual material becomes easy to browse, search, understand, and explore.

The interface should feel like a personal creative tool, not a SaaS dashboard, database, productivity app, or social network.

## 1. Reference hierarchy

We use three products as references, each for a different problem.

### mymind — primary reference

mymind defines the overall personality and interaction philosophy.

Use it for:
- Overall visual language
- Quietness and restraint
- Search experience
- Progressive disclosure
- Details views
- Personal/private feeling
- Minimal interface chrome
- AI that disappears into the experience

When uncertain about how an interaction should feel, prefer the mymind direction.

Do NOT copy its branding, exact UI, colors, or layouts.

### Pinterest — visual library reference

Pinterest defines how a large visual collection should behave as a browsable canvas.

Use it for:
- Image-first browsing
- Natural image proportions
- Masonry / fluid visual grids
- Visual density
- Responsive gallery behaviour
- Lightweight filters
- Hover/contextual actions
- Visual discovery

Do NOT import:
- Social mechanics
- Likes
- Boards as the primary organizational model
- Engagement patterns
- Trending/feed mechanics
- Pinterest branding

The archive is personal, not social.

### Cosmos — relational exploration reference

Cosmos defines how the archive can eventually become interconnected.

Use it for:
- Related items
- Contextual relationships
- Visual connections
- Rabbit-hole exploration
- Moving from one reference to another through shared qualities

Cosmos is a FUTURE interaction reference.

Do not introduce Cosmos-style relational complexity into the initial library.

## 2. Core design philosophy

### Visual-first

The archive is primarily a collection of visual material.

Media is the dominant content.

Metadata should support the media, not compete with it.

### Search + browse

Users should be able to:
- arrive with a specific memory or query
- browse without knowing what they are looking for
- move naturally between searching and wandering

Search should feel like a natural part of the library, not a separate "search results" application: it opens from the library in place, and its results keep the library's visual language.

### Save now, organize never

The product should preserve the low-friction behaviour that created the archive.

Do not make users manually organize everything before the archive becomes useful.

Organization should emerge through search, AI interpretation, relationships, and optional user context.

### Search understands messy memory

Users may search using:
- imperfect wording
- vague memories
- visual concepts
- slang
- partial descriptions
- concepts rather than exact taxonomy

Do not require users to know the system's vocabulary.

Note: the current search engine does not fully support this yet. This is a product/design principle, not permission to redesign retrieval during UI work.

### Everything can lead somewhere

A reference should eventually be able to lead to:
- related visual material
- related concepts
- other saved references
- rabbit holes

This is the foundation for the future Cosmos-inspired exploration layer.

### My context > AI context

AI can describe and organize content.

AI must never claim to know why the user saved something unless the user explicitly provided that context.

User context and notes are authoritative.

### AI disappears when useful

The interface should not constantly advertise:
- models
- providers
- prompts
- confidence scores
- technical AI machinery

Show useful interpretation.

Hide the machinery.

### Personal, not social

This is a personal archive.

Do not introduce:
- engagement mechanics
- popularity
- likes
- follower patterns
- social feeds
- competitive behaviour

### Source-agnostic

Instagram is the first source, not the identity of the product.

UI terminology should avoid unnecessarily coupling the experience to Instagram.

Future sources should be able to enter the same archive model.

### Quiet interface, rich content

The UI should be restrained enough that the user's archive provides most of the visual richness.

Avoid:
- excessive borders
- excessive cards
- decorative gradients
- unnecessary shadows
- loud buttons
- dashboard-style panels

### Collected, not curated

The archive does not need to look perfectly organized.

Mess is valuable.

The product's job is to make the mess navigable.

## 3. Interaction hierarchy

There are two paths into an item, one for each way of arriving:

```
Canvas (wander):  Browse → Focus → Details
Search (find):    Search field in the top nav → active search → Search page → ranked visual grid → Details
```

The levels below describe the Canvas path. Search skips Focus: its results are already a ranked comparison surface, so a result opens its Details directly (see §5).

### Level 1 — Browse

Show:
- visual content
- minimal interface chrome
- search
- lightweight navigation/filter controls

Do not permanently expose dense metadata.

The user should primarily see the things they collected.

### Level 2 — Focus

Clicking an item should create a stronger focus state.

The item becomes the thing the user is looking at.

The surrounding interface should recede.

This is an intentional visual step between browsing and full details.

### Level 3 — Details

Details should be intentionally revealed rather than permanently displayed.

Details may include:
- source
- original context
- creator
- caption
- user note
- AI understanding
- tags
- related references
- edit/review controls

Source should be visible at the top of the details context.

Hover (or keyboard focus) reveals a quiet "Details" pill in a tile's bottom-left corner, on the Canvas and in Search alike; it goes straight to Details. On the Canvas, a click elsewhere on the tile still opens Focus.

Do not turn every grid item into a metadata card.

## 4. Library / grid

The library is the primary surface.

Preferred characteristics:
- image-first
- natural aspect ratios where possible
- fluid/masonry-style layout
- responsive
- visually dense without feeling cramped
- minimal persistent metadata
- media should dominate

The archive currently contains many items without retrieved media. These items must remain represented in the library rather than being silently hidden.

Media-backed items should use their natural aspect ratio where dimensions are available.

Media-less items should have a quiet, visually consistent fallback treatment that does not make the application feel broken.

Avoid defaulting to:
- rigid square cards
- equal-height dashboard cards
- heavy card containers
- permanent captions under every item

The grid should feel like a field of collected references.

## 5. Search

Search is a primary interaction.

It should feel:
- quiet
- obvious
- inviting
- persistent without being intrusive

Search should support imperfect natural-language queries as the product's retrieval capabilities improve.

Search should not make the user feel like they are querying a database.

### The Search flow

```
Search field in the top nav → active search → dedicated Search page → ranked visual grid → Details
```

- **Top nav:** on the Library and Search, the nav is a calm bar in the page colour that the content passes beneath: the archive's name on the left and a wide, rounded search field in the center (search icon, quiet border, prominent but not loud). It stays exactly in place between the Library and Search; only the content beneath it changes.
- **Active search:** clicking the field (or "/") makes it active: it comes forward, solid and slightly larger, and the page beneath it is softly dimmed. Enter submits; a click outside or Escape closes it. The active state is only the field: no recent searches, suggestions, colors or other panels.
- **Search page:** a dedicated page (`/search?q=…`) for finding, not another Canvas. The query stays in the top nav's search field, editable, with a quiet match count beneath it. Below it, the results form a dense visual grid in the search engine's ranked order: best match first, each item once, nothing shuffled or repeated. No filters, sorting, tabs or AI controls.
- **Details, not Focus:** Search has no Focus state. A result card opens its Details directly. Hovering it (or keyboard focus) reveals the same quiet "Details" pill as on the Canvas, in its bottom-left corner, with where the query matched beside it. Back returns to the same query and scroll position.
- **Canvas = wander, Search = find.** The Canvas keeps Browse → Focus → Details.

Do not redesign the underlying retrieval engine as part of this UI task.

## 6. Filters

Filters are secondary.

Use a subtle Filters affordance rather than a permanently visible sidebar.

Filters should help narrow the archive without making the interface feel administrative.

Do not expose every possible database attribute as a filter.

## 7. Details

The details experience should feel closer to a piece of creative software than an admin panel.

Prioritize:
1. Media
2. User context
3. AI understanding
4. Original/source context
5. Related content
6. Editing

AI information should be framed as interpretation/suggestion.

Avoid exposing model/provider/confidence information in the primary experience.

## 8. AI

AI is infrastructure, not the product's personality.

The user should experience the benefits of:
- organization
- semantic understanding
- search
- relationships

without constantly seeing the underlying AI machinery.

Use language such as:
- "AI suggested"
- "AI understanding"

Avoid exposing:
- model names
- provider names
- prompts
- token counts
- raw confidence scores

unless explicitly needed in a backstage/debugging context.

## 9. Missing and processing media

The archive must honestly represent media state.

Possible states include:
- Available
- Processing
- Pending
- Unavailable
- Failed

These states should be visually distinct but quiet.

Do not let missing-media states dominate the visual language.

A missing image should not look like a broken application.

## 10. Cleanup

Cleanup is an intentional mode, not the default browsing experience.

It may use:
- focused single-item presentation
- reduced/blurred surrounding content
- deliberate Keep / Forget actions
- minimal UI

Important: do not implement cleanup or introduce a "forgotten" domain state during this setup or the Library step.

The existing domain is append-only: imports add data and do not remove it. The semantics of "Forget" will be decided when Cleanup is implemented.

## 11. Related / rabbit-hole exploration

This is a later interaction layer.

The desired mental model:

```
item
  ↓
related
  ↓
another reference
  ↓
another connection
  ↓
rabbit hole
```

Relationships may eventually be based on:
- visual similarity
- shared concepts
- tags
- creator
- medium
- style
- user context
- future external sources such as Pinterest

Do not build this during the initial library implementation.

## 12. Visual tone

The interface should feel:

- Quiet
- Curious
- Personal
- Creative
- Observational
- Editorial
- Slightly playful
- Refined but not precious

It should NOT feel:

- Corporate
- Dashboard-heavy
- Enterprise SaaS
- Social-media-like
- Over-engineered
- Loud
- AI-demo-like
- Overly polished to the point of losing personality

## 13. Component philosophy

Prefer a small, coherent component system.

Components should:
- have clear responsibilities
- be reusable
- use shared design tokens
- avoid one-off styling where a system primitive exists

Do not create components merely to abstract a single visual element.

The design system should support the archive rather than become a project in itself.

## 14. Design tokens

Establish shared tokens for:

- Typography
- Font sizes
- Font weights
- Line heights
- Spacing
- Border radius
- Borders
- Surfaces
- Text hierarchy
- Shadows
- Motion
- Breakpoints
- Grid behaviour

Tokens should be tuned to the product rather than copied directly from any reference.

Do not blindly use default shadcn/ui styling.

## 15. Implementation rule

When a reference and the product principles conflict:

1. Product principles win.
2. mymind defines overall interaction personality.
3. Pinterest defines visual-library behaviour.
4. Cosmos defines future relational exploration.
5. Existing product architecture and domain rules remain intact unless a UI change genuinely requires otherwise.

Do not redesign backend/domain behaviour while implementing UI unless explicitly asked.

## 16. Build sequence

The UI will be implemented in five stages:

### Step 1 — Library
Build the visual archive surface.

### Step 2 — Focus
Build the interaction state when a user focuses an item.

### Step 3 — Details
Build the intentional details/context experience.

### Step 4 — Cleanup
Build the deliberate Keep / Forget cleanup mode.

### Step 5 — Related
Build the first version of contextual/rabbit-hole exploration.

Do not jump ahead.
