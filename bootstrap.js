/* Zotero Tag Logic
 *
 * Tag Selector filtering with per-tag roles:
 *
 *   MUST  the item must have this tag                    (plain click in AND mode)
 *   ANY   the item must have at least one of the ANY tags (plain click in OR mode)
 *   NOT   the item must have none of the NOT tags         (Alt+click)
 *
 * Ctrl+click sets the role that a plain click does not (ANY in AND mode, MUST in OR mode).
 * Result = (ANY1 OR ANY2 ...) AND MUST1 AND MUST2 ... AND NOT NOT1 AND NOT NOT2 ...
 *
 * How it works (Zotero 8+): CollectionTreeRow builds the items-pane search from
 * "collection scope + quick search + selected tags", with every selected tag ANDed.
 * When the selection needs more than that, we build the same search *without* tags (the
 * "base" search), then wrap it in a second, unsaved Zotero.Search scoped to the base
 * results whose conditions are  tag-is (MUST), tag-isNot (NOT) and one condition group
 * (tag A OR tag B ...) for ANY. Nothing is written to the database.
 *
 * The Tag Selector lists only tags found in the current results, so the ANY and NOT tags
 * would vanish from it. While those roles are in use, the tag list is fed from the base
 * results narrowed by MUST and NOT only (ANY ignored), and the selected tags are always
 * kept in the list so they can be deselected.
 */

var TagLogic;

const PREF_MODE = 'extensions.zotero-tag-logic.mode';

const STRINGS = {
	en: {
		and: 'AND',
		or: 'OR',
		modeAnd: 'Tag match: AND — a plain click means "must have".',
		modeOr: 'Tag match: OR — a plain click means "any of".',
		hintAnd: 'Ctrl+click: any of  ·  Alt+click: NOT  ·  Click the toggle to switch.',
		hintOr: 'Ctrl+click: must have  ·  Alt+click: NOT  ·  Click the toggle to switch.',
		menuOr: 'Match Any Selected Tag (OR)',
		not: 'NOT'
	},
	zh: {
		and: 'AND',
		or: 'OR',
		modeAnd: '标签匹配：AND — 普通点击表示“必须有”。',
		modeOr: '标签匹配：OR — 普通点击表示“任一”。',
		hintAnd: 'Ctrl+点击：任一  ·  Alt+点击：排除 (NOT)  ·  点击开关切换模式',
		hintOr: 'Ctrl+点击：必须有  ·  Alt+点击：排除 (NOT)  ·  点击开关切换模式',
		menuOr: '匹配任一已选标签（OR）',
		not: 'NOT'
	}
};

const STYLE = `
.tag-logic-toggle {
	appearance: none;
	flex-shrink: 0;
	align-self: center;
	display: flex;
	margin: 0;
	padding: 0;
	overflow: hidden;
	border: 1px solid var(--fill-quarternary);
	border-radius: 5px;
	background: transparent;
	color: var(--fill-secondary);
	font: inherit;
	font-size: 0.85em;
	font-weight: 600;
	line-height: 1.2;
}
.tag-logic-toggle:hover {
	background-color: var(--fill-quinary);
}
.tag-logic-toggle > span {
	padding: 2px 6px;
}
.tag-logic-toggle > span[data-active="true"] {
	background-color: var(--accent-blue);
	color: var(--accent-white);
}

/* ANY: outlined, with a union marker */
.tag-selector-item.selected[data-tl-role="any"] {
	background-color: transparent !important;
	color: var(--accent-blue) !important;
	box-shadow: inset 0 0 0 1px var(--accent-blue);
}
.tag-selector-item.selected[data-tl-role="any"]::after {
	content: " \\222a";
	opacity: 0.7;
}
/* NOT: red, struck through */
.tag-selector-item.selected[data-tl-role="not"] {
	background-color: var(--accent-red) !important;
	color: var(--accent-white) !important;
	text-decoration: line-through;
}
`;

function install() {}
function uninstall() {}

async function startup({ id, version, rootURI }, reason) {
	await Promise.all([
		Zotero.initializationPromise,
		Zotero.unlockPromise,
		Zotero.uiReadyPromise
	]);
	TagLogic = new TagLogicPlugin();
	TagLogic.init();
	for (let win of Zotero.getMainWindows()) {
		TagLogic.addToWindow(win);
	}
}

function onMainWindowLoad({ window }) {
	TagLogic?.addToWindow(window);
}

function onMainWindowUnload({ window }) {
	TagLogic?.removeFromWindow(window);
}

async function shutdown(data, reason) {
	if (reason === APP_SHUTDOWN) {
		return;
	}
	await TagLogic?.destroy();
	TagLogic = null;
}


class TagLogicPlugin {
	constructor() {
		this.destroyed = false;
		this.windows = new Map();
		this.patches = [];
		this.orig = {};
		let locale = (Zotero.locale || 'en').toLowerCase();
		this.str = locale.startsWith('zh') ? STRINGS.zh : STRINGS.en;
	}

	get mode() {
		return Zotero.Prefs.get(PREF_MODE, true) === 'or' ? 'or' : 'and';
	}

	// ----------------------------------------------------------------------
	// Roles
	// ----------------------------------------------------------------------

	/** Role of a selected tag: an explicit one if set, otherwise the mode's default */
	roleOf(row, tag) {
		return row._tlRoles?.get(tag) ?? (this.mode === 'or' ? 'any' : 'must');
	}

	/** Split the row's selected tags by role */
	partition(row) {
		let parts = { must: [], any: [], not: [] };
		for (let tag of row.tags || []) {
			parts[this.roleOf(row, tag)].push(tag);
		}
		return parts;
	}

	/** Native Zotero already gives the right result when there is no NOT and at most one ANY */
	isNative(parts) {
		return parts.not.length === 0 && parts.any.length <= 1;
	}

	/** Whether the items search needs our wrapper */
	filterActive(row) {
		return !this.destroyed && row.tags?.size > 0 && !this.isNative(this.partition(row));
	}

	/** Whether the tag list must be fed from the tag-unfiltered scope */
	scopeActive(row) {
		if (this.destroyed || !(row.tags?.size > 0)) {
			return false;
		}
		let parts = this.partition(row);
		return parts.any.length >= 1 || parts.not.length >= 1;
	}

	/** Human-readable form of the current filter, e.g. (A OR B) AND C AND NOT D */
	describe(row) {
		if (!row || !(row.tags?.size > 0)) {
			return '';
		}
		let { must, any, not } = this.partition(row);
		let out = [];
		if (any.length) {
			out.push(any.length > 1 ? `(${any.join(' OR ')})` : any[0]);
		}
		out.push(...must);
		let text = out.join(' AND ');
		for (let tag of not) {
			text += (text ? ' AND ' : '') + `${this.str.not} ${tag}`;
		}
		return text;
	}

	// ----------------------------------------------------------------------
	// Search patches
	// ----------------------------------------------------------------------

	init() {
		let plugin = this;
		let proto = Zotero.CollectionTreeRow.prototype;

		this.orig.getSearchObject = proto.getSearchObject;

		this.patch(proto, 'getSearchObject', (orig) => async function (options = {}) {
			if (options.unfiltered || !plugin.filterActive(this)) {
				return orig.call(this, options);
			}
			if (!this._tlFilterP) {
				// Read the roles now, before any await
				let parts = plugin.partition(this);
				this._tlFilterP = plugin.buildFilter(this, parts, true).catch((e) => {
					this._tlFilterP = null;
					throw e;
				});
			}
			return this._tlFilterP;
		});

		this.patch(proto, 'getTags', (orig) => async function (types, tagIDs) {
			if (!plugin.scopeActive(this)) {
				return orig.call(this, types, tagIDs);
			}
			switch (this.type) {
				case 'share':
				case 'bucket':
				case 'feeds':
					return [];
			}
			let ids = await plugin.getScopeResults(this);
			let tags = await plugin.tagsForIDs(ids, types, tagIDs);
			if (!types && !tagIDs) {
				plugin.addSelectedTags(tags, this);
			}
			return tags;
		});

		this.patch(proto, 'clearCache', (orig) => function () {
			this._tlBaseP = null;
			this._tlBaseResultsP = null;
			this._tlScopeResultsP = null;
			this._tlFilterP = null;
			return orig.apply(this, arguments);
		});

		// Drop roles of tags that are no longer selected
		this.patch(proto, 'setTags', (orig) => function (tags) {
			if (this._tlRoles?.size) {
				let keep = tags instanceof Set ? tags : new Set(tags || []);
				for (let tag of [...this._tlRoles.keys()]) {
					if (!keep.has(tag)) {
						this._tlRoles.delete(tag);
					}
				}
			}
			return orig.call(this, tags);
		});

		this.patch(Zotero.CollectionTreeRow, 'getTagsAcrossRows', (orig) => async function (rows, types, tagIDs) {
			if (!rows.some((row) => plugin.scopeActive(row))) {
				return orig.call(this, rows, types, tagIDs);
			}
			// Same as the original, but rows using ANY/NOT contribute their tag-list scope
			let tagRows = rows.filter((row) => !['share', 'bucket', 'feeds'].includes(row.type));
			if (!tagRows.length) {
				return [];
			}
			let itemIDs = new Set();
			let resultSets = await Promise.all(tagRows.map(
				(row) => plugin.scopeActive(row)
					? plugin.getScopeResults(row)
					: row.getSearchResults(false)
			));
			for (let ids of resultSets) {
				for (let id of ids) {
					itemIDs.add(id);
				}
			}
			let tags = await plugin.tagsForIDs([...itemIDs], types, tagIDs);
			if (!types && !tagIDs) {
				for (let row of tagRows) {
					if (plugin.scopeActive(row)) {
						plugin.addSelectedTags(tags, row);
					}
				}
			}
			return tags;
		});

		Zotero.TagLogic = this;
	}

	patch(obj, name, factory) {
		let orig = obj[name];
		let wrapper = factory(orig);
		obj[name] = wrapper;
		this.patches.push({ obj, name, orig, wrapper });
	}

	async tagsForIDs(ids, types, tagIDs) {
		let tmpTable = await Zotero.Search.idsToTempTable(ids);
		try {
			return await Zotero.Tags.getAllWithin({ tmpTable, types, tagIDs });
		}
		finally {
			await Zotero.DB.queryAsync(`DROP TABLE IF EXISTS ${tmpTable}`, false, { noCache: true });
		}
	}

	/** Selected tags must stay in the list even if the scope excludes them (NOT, ANY) */
	addSelectedTags(tags, row) {
		let present = new Set(tags.map((t) => t.tag));
		for (let tag of row.tags) {
			if (!present.has(tag)) {
				tags.push({ tag, type: 0 });
				present.add(tag);
			}
		}
	}

	/**
	 * The row's normal search (collection scope, quick search, advanced search) but with
	 * no tag filter. Built by running the original getSearchObject() on a throwaway object
	 * that inherits from the row, so the real row's state is never touched.
	 */
	getBase(row) {
		if (!row._tlBaseP) {
			row._tlBaseP = (async () => {
				let shadow = Object.create(row);
				shadow.tags = new Set();
				shadow._cachedSearch = null;
				let prevUnload = row.onUnload;
				let search = await this.orig.getSearchObject.call(shadow, {});
				// Keep cleanup callbacks (temp tables) from searches built on the shadow
				if (Object.prototype.hasOwnProperty.call(shadow, 'onUnload')
						&& shadow.onUnload && shadow.onUnload !== prevUnload) {
					let added = shadow.onUnload;
					row.onUnload = prevUnload
						? async function () {
							await prevUnload();
							await added();
						}
						: added;
				}
				return search;
			})().catch((e) => {
				row._tlBaseP = null;
				throw e;
			});
		}
		return row._tlBaseP;
	}

	async runSearch(search) {
		try {
			return await search.search();
		}
		catch (e) {
			Zotero.logError(e);
			throw new Zotero.CollectionTreeRow.SearchError(e);
		}
	}

	getBaseResults(row) {
		if (!row._tlBaseResultsP) {
			row._tlBaseResultsP = (async () => this.runSearch(await this.getBase(row)))()
				.catch((e) => {
					row._tlBaseResultsP = null;
					throw e;
				});
		}
		return row._tlBaseResultsP;
	}

	/** Item IDs the tag list is built from: the base results narrowed by MUST and NOT, ignoring ANY */
	getScopeResults(row) {
		if (!row._tlScopeResultsP) {
			let parts = this.partition(row);
			row._tlScopeResultsP = (async () => {
				if (!parts.must.length && !parts.not.length) {
					return this.getBaseResults(row);
				}
				return this.runSearch(await this.buildFilter(row, parts, false));
			})().catch((e) => {
				row._tlScopeResultsP = null;
				throw e;
			});
		}
		return row._tlScopeResultsP;
	}

	/**
	 * Unsaved search scoped to the row's tag-less base search:
	 *   MUST tags ANDed, NOT tags excluded and, if withAny, (ANY tags ORed).
	 */
	async buildFilter(row, parts, withAny) {
		let base = await this.getBase(row);
		let s = new Zotero.Search();
		// Same library/trash handling as the outer search in CollectionTreeRow
		if (row.isFeeds()) {
			s.addCondition('feed', true);
		}
		else {
			s.libraryID = row.ref.libraryID;
		}
		if (row.isTrash()) {
			s.addCondition('deleted', 'true');
		}
		for (let tag of parts.must) {
			s.addCondition('tag', 'is', tag);
		}
		for (let tag of parts.not) {
			s.addCondition('tag', 'isNot', tag);
		}
		if (withAny && parts.any.length) {
			s.addCondition('groupStart', 'true', '');
			s.addCondition('joinMode', 'any');
			for (let tag of parts.any) {
				s.addCondition('tag', 'is', tag);
			}
			s.addCondition('groupEnd', 'true', '');
		}
		s.setScope(base, false);
		return s;
	}

	// ----------------------------------------------------------------------
	// Mode and role switching
	// ----------------------------------------------------------------------

	async setMode(mode) {
		mode = mode === 'or' ? 'or' : 'and';
		if (mode === this.mode) {
			return;
		}
		Zotero.Prefs.set(PREF_MODE, mode, true);
		await Promise.all(Zotero.getMainWindows().map((win) => this.refreshView(win)));
		for (let win of this.windows.keys()) {
			this.updateUI(win);
		}
	}

	toggleMode() {
		return this.setMode(this.mode === 'or' ? 'and' : 'or');
	}

	/**
	 * Alt+click / Ctrl+click on a tag.
	 * @param {String} name
	 * @param {'not'|'other'} modifier - 'other' is the role a plain click does not give
	 */
	async setRole(win, name, modifier) {
		try {
			let pane = win.ZoteroPane;
			let tagSelector = pane?.tagSelector;
			let view = pane?.itemsView;
			if (!tagSelector || !view) {
				return;
			}
			let rows = view.collectionTreeRows;
			if (!rows.length) {
				return;
			}
			let wanted = modifier === 'not' ? 'not' : (this.mode === 'or' ? 'must' : 'any');
			let selected = tagSelector.selectedTags.has(name);

			// Same role again: deselect, like a plain click on a selected tag
			if (selected && this.roleOf(rows[0], name) === wanted) {
				tagSelector.handleTagSelected(name);
				return;
			}

			for (let row of rows) {
				if (!row._tlRoles) {
					row._tlRoles = new Map();
				}
				row._tlRoles.set(name, wanted);
			}
			if (!selected) {
				// Selecting runs the normal path: onSelection -> setFilter -> setTags -> refresh
				tagSelector.handleTagSelected(name);
				return;
			}
			// Role of an already-selected tag changed: the tag set is the same, so setTags()
			// won't trigger a refresh
			await this.refreshView(win);
		}
		catch (e) {
			Zotero.logError(e);
		}
	}

	/** Re-run the current view's search, but only if tags are selected (otherwise nothing changes) */
	async refreshView(win) {
		try {
			let pane = win.ZoteroPane;
			let view = pane?.itemsView;
			if (!view || !pane.tagSelector) {
				return;
			}
			for (let row of view.collectionTreeRows) {
				row.clearCache();
			}
			if (!(pane.tagSelector.getTagSelection()?.size >= 1)) {
				return;
			}
			await view.rowProvider.refresh({ restoreSelection: true });
		}
		catch (e) {
			Zotero.logError(e);
		}
	}

	// ----------------------------------------------------------------------
	// UI
	// ----------------------------------------------------------------------

	addToWindow(win) {
		if (this.windows.has(win)) {
			return;
		}
		let doc = win.document;
		let state = { observer: null, timer: null, container: null, onClick: null };
		this.windows.set(win, state);

		let style = doc.createElement('style');
		style.id = 'tag-logic-style';
		style.textContent = STYLE;
		doc.documentElement.appendChild(style);

		this.ensureUI(win);

		let container = doc.getElementById('zotero-tag-selector-container');
		if (container) {
			// Capture phase, so modified clicks never reach the tag selector's own handler
			state.container = container;
			state.onClick = (ev) => this.onTagClick(win, ev);
			container.addEventListener('click', state.onClick, true);

			// The tag selector is a React tree that gets rebuilt when it is hidden and shown
			// again, and re-renders tags as the selection changes, so re-attach the toggle
			// and re-mark the tags whenever the DOM changes
			state.observer = new win.MutationObserver(() => {
				if (state.timer) {
					return;
				}
				state.timer = win.setTimeout(() => {
					state.timer = null;
					this.ensureUI(win);
				}, 50);
			});
			state.observer.observe(container, {
				childList: true,
				subtree: true,
				attributes: true,
				attributeFilter: ['class']
			});
		}
	}

	removeFromWindow(win) {
		let state = this.windows.get(win);
		if (!state) {
			return;
		}
		this.windows.delete(win);
		state.observer?.disconnect();
		state.container?.removeEventListener('click', state.onClick, true);
		if (state.timer) {
			win.clearTimeout(state.timer);
		}
		let doc = win.document;
		doc.querySelectorAll('.tag-logic-toggle, #tag-logic-menuitem, #tag-logic-expr, #tag-logic-style')
			.forEach((el) => el.remove());
		doc.querySelectorAll('[data-tl-role]').forEach((el) => delete el.dataset.tlRole);
	}

	onTagClick(win, ev) {
		if (ev.button !== 0 || this.destroyed) {
			return;
		}
		let modifier = ev.altKey ? 'not' : (ev.ctrlKey || ev.metaKey) ? 'other' : null;
		if (!modifier) {
			return;
		}
		let item = ev.target.closest?.('.tag-selector-item');
		if (!item || item.classList.contains('disabled')) {
			return;
		}
		ev.preventDefault();
		ev.stopPropagation();
		this.setRole(win, item.textContent, modifier);
	}

	ensureUI(win) {
		let doc = win.document;

		// Button next to the tag filter box
		let filterContainer = doc.querySelector('#zotero-tag-selector .tag-selector-filter-container');
		if (filterContainer && !filterContainer.querySelector('.tag-logic-toggle')) {
			let btn = doc.createElement('button');
			btn.className = 'tag-logic-toggle';
			btn.type = 'button';
			// Keep out of the tag selector's custom Tab order
			btn.tabIndex = -1;
			for (let mode of ['and', 'or']) {
				let seg = doc.createElement('span');
				seg.dataset.mode = mode;
				seg.textContent = this.str[mode];
				btn.appendChild(seg);
			}
			btn.addEventListener('click', (ev) => {
				ev.preventDefault();
				ev.stopPropagation();
				this.toggleMode();
			});
			filterContainer.insertBefore(btn, filterContainer.querySelector('.tag-selector-actions'));
		}

		// Items in the tag selector's settings menu: the mode checkbox (keyboard-accessible
		// alternative to the button) and a read-only line showing the current filter
		let menu = doc.getElementById('tag-selector-view-settings-menu');
		if (menu && !doc.getElementById('tag-logic-menuitem')) {
			let expr = doc.createXULElement('menuitem');
			expr.id = 'tag-logic-expr';
			expr.setAttribute('disabled', 'true');
			expr.hidden = true;
			menu.insertBefore(expr, doc.getElementById('num-selected')?.nextSibling || null);

			let item = doc.createXULElement('menuitem');
			item.id = 'tag-logic-menuitem';
			item.setAttribute('type', 'checkbox');
			item.setAttribute('label', this.str.menuOr);
			item.addEventListener('command', () => this.toggleMode());
			menu.insertBefore(item, doc.getElementById('deselect-all')?.nextSibling || null);
			menu.addEventListener('popupshowing', () => this.updateUI(win));
		}

		this.updateUI(win);
	}

	updateUI(win) {
		let doc = win.document;
		let mode = this.mode;
		let row = win.ZoteroPane?.itemsView?.collectionTreeRows?.[0];
		let expression = this.describe(row);

		// Mark selected tags that are not plain MUST
		for (let el of doc.querySelectorAll('#zotero-tag-selector .tag-selector-item')) {
			let role = row && el.classList.contains('selected') ? this.roleOf(row, el.textContent) : null;
			if (role && role !== 'must') {
				el.dataset.tlRole = role;
			}
			else {
				delete el.dataset.tlRole;
			}
		}

		let btn = doc.querySelector('.tag-logic-toggle');
		if (btn) {
			for (let seg of btn.children) {
				seg.dataset.active = String(seg.dataset.mode === mode);
			}
			let lines = [
				mode === 'or' ? this.str.modeOr : this.str.modeAnd,
				mode === 'or' ? this.str.hintOr : this.str.hintAnd
			];
			if (expression) {
				lines.push('', expression);
			}
			btn.title = lines.join('\n');
		}
		let item = doc.getElementById('tag-logic-menuitem');
		if (item) {
			item.setAttribute('checked', String(mode === 'or'));
		}
		let exprItem = doc.getElementById('tag-logic-expr');
		if (exprItem) {
			exprItem.setAttribute('label', expression);
			exprItem.hidden = !expression;
		}
	}

	// ----------------------------------------------------------------------

	async destroy() {
		this.destroyed = true;
		let wins = Zotero.getMainWindows();
		for (let win of [...this.windows.keys()]) {
			this.removeFromWindow(win);
		}
		for (let { obj, name, orig, wrapper } of this.patches.reverse()) {
			if (obj[name] === wrapper) {
				obj[name] = orig;
			}
		}
		this.patches = [];
		// Drop cached searches and roles, and restore native results
		for (let win of wins) {
			let rows = win.ZoteroPane?.itemsView?.collectionTreeRows || [];
			for (let row of rows) {
				row._tlBaseP = row._tlBaseResultsP = row._tlScopeResultsP = row._tlFilterP = null;
				row._tlRoles = null;
			}
			await this.refreshView(win);
		}
		delete Zotero.TagLogic;
	}
}
