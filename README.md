# Zotero Tag Logic

Adds an **AND / OR** toggle next to the Tag Selector's filter box (also available as a checkbox in the
Tag Selector's settings menu: *Match Any Selected Tag (OR)*).

![AND / OR toggle next to the Tag Selector filter box](docs/toggle.png)

- **AND** (default): native Zotero behavior.
- **OR**: selecting several tags shows items that have *any* of them. The tag list keeps showing every
  tag in the current scope, so you can keep adding tags.
- Mode is saved in the pref `extensions.zotero-tag-logic.mode` and survives restarts.
- Nothing is written to the Zotero database and no saved search is created.

Target: Zotero 8–10 (developed against 10.0.5).

## How it works

`Zotero.CollectionTreeRow.getSearchObject()` normally ANDs every selected tag into the items search.
In OR mode the plugin builds the same search without tags, then scopes a second unsaved `Zotero.Search`
to it containing one condition group: `( tag A OR tag B OR ... )`. `getTags()` is patched to read from
the tag-less scope while OR mode is on. Patches are removed when the plugin is disabled.

## Install

Download the `.xpi` from the [Releases](../../releases) page, then in Zotero:
Tools → Plugins → gear icon → *Install Plugin From File…*.

## Build from source

```
python build.py   # writes dist/zotero-tag-logic-<version>.xpi
```

## Debugging

`Zotero.TagLogic.mode`, `Zotero.TagLogic.setMode('or' | 'and')` are available from Tools → Developer → Run JavaScript.

## License

MIT
