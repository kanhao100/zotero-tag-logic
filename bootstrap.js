/* Zotero Tag Logic
 *
 * Adds an AND / OR toggle to the Tag Selector.
 *
 * How it works (Zotero 8+): CollectionTreeRow builds the items-pane search from
 * "collection scope + quick search + selected tags", with every selected tag ANDed.
 * In OR mode we build the same search *without* tags (the "base" search), then wrap it
 * in a second, unsaved Zotero.Search scoped to the base results whose only condition is
 * a group  ( tag A OR tag B OR ... ). Nothing is written to the database.
 *
 * The Tag Selector lists only tags found in the current results, so with the OR filter
 * applied the other tags would vanish. In OR mode we therefore feed the tag list from
 * the base results instead.
 */

var TagLogic;

const PREF_MODE = 'extensions.zotero-tag-logic.mode';

const STRINGS = {
	en: {
		and: 'AND',
		or: 'OR',
		titleAnd: 'Tag match: AND — items must have all selected tags.\nClick to switch to OR.',
		titleOr: 'Tag match: OR — items with any selected tag.\nClick to switch to AND.',
		menuOr: 'Match Any Selected Tag (OR)'
	},
	zh: {
		and: 'AND',
		or: 'OR',
		titleAnd: '标签匹配：AND — 条目须同时具有所有已选标签。\n点击切换为 OR。',
		titleOr: '标签匹配：OR — 条目具有任一已选标签即可。\n点击切换为 AND。',
		menuOr: '匹配任一已选标签（OR）'
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
	// Search patches
	// ----------------------------------------------------------------------

	/** OR group in the items search: only when 2+ tags are selected */
	orSearchActive(row) {
		return !this.destroyed && this.mode === 'or' && row.tags?.size >= 2;
	}

	/** Tag list scope ignoring the tag filter: whenever any tag is selected */
	orScopeActive(row) {
		return !this.destroyed && this.mode === 'or' && row.tags?.size >= 1;
	}

	init() {
		let plugin = this;
		let proto = Zotero.CollectionTreeRow.prototype;

		this.orig.getSearchObject = proto.getSearchObject;

		this.patch(proto, 'getSearchObject', (orig) => async function (options = {}) {
			if (options.unfiltered || !plugin.orSearchActive(this)) {
				return orig.call(this, options);
			}
			if (!this._tlOrSearchP) {
				// Read the tags now, before any await
				let tags = [...this.tags];
				this._tlOrSearchP = plugin.buildOrSearch(this, tags).catch((e) => {
					this._tlOrSearchP = null;
					throw e;
				});
			}
			return this._tlOrSearchP;
		});

		this.patch(proto, 'getTags', (orig) => async function (types, tagIDs) {
			if (!plugin.orScopeActive(this)) {
				return orig.call(this, types, tagIDs);
			}
			switch (this.type) {
				case 'share':
				case 'bucket':
				case 'feeds':
					return [];
			}
			let ids = await plugin.getBaseResults(this);
			let tmpTable = await Zotero.Search.idsToTempTable(ids);
			try {
				return await Zotero.Tags.getAllWithin({ tmpTable, types, tagIDs });
			}
			finally {
				await Zotero.DB.queryAsync(`DROP TABLE IF EXISTS ${tmpTable}`, false, { noCache: true });
			}
		});

		this.patch(proto, 'clearCache', (orig) => function () {
			this._tlBaseP = null;
			this._tlBaseResultsP = null;
			this._tlOrSearchP = null;
			return orig.apply(this, arguments);
		});

		this.patch(Zotero.CollectionTreeRow, 'getTagsAcrossRows', (orig) => async function (rows, types, tagIDs) {
			if (!rows.some((row) => plugin.orScopeActive(row))) {
				return orig.call(this, rows, types, tagIDs);
			}
			// Same as the original, but rows in OR mode contribute their tag-unfiltered scope
			let tagRows = rows.filter((row) => !['share', 'bucket', 'feeds'].includes(row.type));
			if (!tagRows.length) {
				return [];
			}
			let itemIDs = new Set();
			let resultSets = await Promise.all(tagRows.map(
				(row) => plugin.orScopeActive(row)
					? plugin.getBaseResults(row)
					: row.getSearchResults(false)
			));
			for (let ids of resultSets) {
				for (let id of ids) {
					itemIDs.add(id);
				}
			}
			let tmpTable = await Zotero.Search.idsToTempTable([...itemIDs]);
			try {
				return await Zotero.Tags.getAllWithin({ tmpTable, types, tagIDs });
			}
			finally {
				await Zotero.DB.queryAsync(`DROP TABLE IF EXISTS ${tmpTable}`, false, { noCache: true });
			}
		});

		Zotero.TagLogic = this;
	}

	patch(obj, name, factory) {
		let orig = obj[name];
		let wrapper = factory(orig);
		obj[name] = wrapper;
		this.patches.push({ obj, name, orig, wrapper });
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

	getBaseResults(row) {
		if (!row._tlBaseResultsP) {
			row._tlBaseResultsP = (async () => {
				let search = await this.getBase(row);
				try {
					return await search.search();
				}
				catch (e) {
					Zotero.logError(e);
					throw new Zotero.CollectionTreeRow.SearchError(e);
				}
			})().catch((e) => {
				row._tlBaseResultsP = null;
				throw e;
			});
		}
		return row._tlBaseResultsP;
	}

	async buildOrSearch(row, tags) {
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
		s.addCondition('groupStart', 'true', '');
		s.addCondition('joinMode', 'any');
		for (let tag of tags) {
			s.addCondition('tag', 'is', tag);
		}
		s.addCondition('groupEnd', 'true', '');
		s.setScope(base, false);
		return s;
	}

	// ----------------------------------------------------------------------
	// Mode switching
	// ----------------------------------------------------------------------

	async setMode(mode) {
		mode = mode === 'or' ? 'or' : 'and';
		if (mode === this.mode) {
			return;
		}
		Zotero.Prefs.set(PREF_MODE, mode, true);
		for (let win of this.windows.keys()) {
			this.updateUI(win);
		}
		await Promise.all(Zotero.getMainWindows().map((win) => this.refreshView(win)));
	}

	toggleMode() {
		return this.setMode(this.mode === 'or' ? 'and' : 'or');
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
		let state = { observer: null, timer: null };
		this.windows.set(win, state);

		let style = doc.createElement('style');
		style.id = 'tag-logic-style';
		style.textContent = STYLE;
		doc.documentElement.appendChild(style);

		this.ensureUI(win);

		// The tag selector is a React tree that gets rebuilt when it is hidden and shown
		// again, so re-attach the toggle whenever it goes missing
		let container = doc.getElementById('zotero-tag-selector-container');
		if (container) {
			state.observer = new win.MutationObserver(() => {
				if (state.timer) {
					return;
				}
				state.timer = win.setTimeout(() => {
					state.timer = null;
					this.ensureUI(win);
				}, 50);
			});
			state.observer.observe(container, { childList: true, subtree: true });
		}
	}

	removeFromWindow(win) {
		let state = this.windows.get(win);
		if (!state) {
			return;
		}
		this.windows.delete(win);
		state.observer?.disconnect();
		if (state.timer) {
			win.clearTimeout(state.timer);
		}
		let doc = win.document;
		doc.querySelectorAll('.tag-logic-toggle, #tag-logic-menuitem, #tag-logic-style')
			.forEach((el) => el.remove());
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

		// Checkbox in the tag selector's settings menu (keyboard-accessible alternative)
		let menu = doc.getElementById('tag-selector-view-settings-menu');
		if (menu && !doc.getElementById('tag-logic-menuitem')) {
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
		let btn = doc.querySelector('.tag-logic-toggle');
		if (btn) {
			for (let seg of btn.children) {
				seg.dataset.active = String(seg.dataset.mode === mode);
			}
			btn.title = mode === 'or' ? this.str.titleOr : this.str.titleAnd;
		}
		let item = doc.getElementById('tag-logic-menuitem');
		if (item) {
			item.setAttribute('checked', String(mode === 'or'));
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
		// Drop cached OR searches and restore native results
		for (let win of wins) {
			let rows = win.ZoteroPane?.itemsView?.collectionTreeRows || [];
			for (let row of rows) {
				row._tlBaseP = row._tlBaseResultsP = row._tlOrSearchP = null;
			}
			await this.refreshView(win);
		}
		delete Zotero.TagLogic;
	}
}
