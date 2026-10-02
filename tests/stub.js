// Allzweck-Platzhalter: akzeptiert jede Methode/Eigenschaft, damit nur UNSERE Logikfehler auffallen
const make = () => new Proxy(function () {}, {
    get: (t, k) => (k === 'then' ? undefined : k === Symbol.toPrimitive ? () => 0 : k === 'isOpen' ? true : k === 'label' ? make() : make()),
    set: () => true,
    apply: () => make(),
    construct: () => make(),
});
export default make();
export const Extension = class { getSettings() { return fakeSettings; } openPreferences() {} get metadata() { return {version: 2}; } };
const fakeSettings = {
    get_string: k => ({retention: '3d', 'panel-position': 'right'}[k] ?? ''), get_uint: () => 5, get_boolean: () => false,
    get_strv: () => [], set_string() {}, set_uint() {},
};
export const Main = {panel: {addToStatusArea() {}, height: 32}, uiGroup: make(), layoutManager: make()};
export const PanelMenu = {Button: class { constructor() { this.menu = menu; } add_child() {} destroy() {} }};
const items = [];
export const menu = {isOpen: true, addMenuItem: i => items.push(i), removeAll: () => { items.length = 0; }, connect: () => 1, actor: make(), items};
const Item = class { constructor() { this.label = make(); } add_child() {} connect() {} };
export const PopupMenu = {PopupBaseMenuItem: Item, PopupImageMenuItem: Item, PopupSeparatorMenuItem: Item, PopupMenuItem: Item, PopupSwitchMenuItem: Item, PopupSubMenuMenuItem: Item};
export const Clutter = {ActorAlign: {CENTER: 1, FILL: 2}, EVENT_PROPAGATE: false};
export const St = new Proxy({}, {get: () => class { constructor() {} add_child() {} destroy_all_children() {} show() {} hide() {} set_position() {} connect() {} }});
