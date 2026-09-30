// Mock of the parts of photos.google.com that Sweep drives: a virtualised,
// scrolling grid of tiles with checkboxes, the "N selected" counter, the trash
// button (library) or ⋮ menu (album), the "#" shortcut, and the confirm dialog.
// Behaviour switches come from the query string: ?confirm=permanent, ?deaf=1.
(() => {
  const viewer = JSON.parse(document.getElementById("viewer").textContent);
  if (viewer) return photoPage(viewer);
  const items = JSON.parse(document.getElementById("items").textContent);
  const params = new URLSearchParams(location.search);
  const album = location.pathname.startsWith("/album/");
  const COLS = 5;
  const SIZE = 180;
  const selected = new Set();
  const log = [];
  window.__mock = { log, selected, items, state: () => ({ remaining: items.length, selected: selected.size, log: [...log] }) };

  const h = (tag, props = {}, ...children) => {
    const element = Object.assign(document.createElement(tag), props.dom || {});
    for (const [key, value] of Object.entries(props)) if (key !== "dom") element.setAttribute(key, value);
    element.append(...children);
    return element;
  };

  const count = h("div", { id: "count" });
  const bar = h("div", { id: "bar" }, count);
  const scroll = h("div", { id: "scroll" });
  const spacer = h("div", { id: "spacer" });
  scroll.append(spacer);
  document.body.append(bar, scroll);

  function updateBar() {
    count.textContent = selected.size && !params.get("nocount") ? `${selected.size} selected` : "";
    bar.querySelectorAll("button, [role=menu]").forEach((element) => element.remove());
    if (!selected.size) return;
    const menu = h("div", { role: "menu", hidden: "" },
      album ? h("div", { role: "menuitem", id: "remove" }, "Remove from album") : "",
      h("div", { role: "menuitem", id: "menu-archive" }, h("span", {}, "Archive"), h("span", {}, "Shift+A")),
      h("div", { role: "menuitem", id: "menu-lock" }, "Move to Locked Folder"),
      album ? h("div", { role: "menuitem", id: "menu-trash" }, "Move to trash") : "");
    const more = h("button", { "aria-label": "More options" }, "⋮");
    more.onclick = () => { menu.hidden = !menu.hidden; log.push("menu"); };
    menu.querySelector("#menu-archive").onclick = () => { menu.hidden = true; archive("menu-archive"); };
    menu.querySelector("#menu-lock").onclick = () => { menu.hidden = true; log.push("menu-lock"); openLockDialog(); };
    if (album) {
      menu.querySelector("#remove").onclick = () => log.push("REMOVED-FROM-ALBUM");
      menu.querySelector("#menu-trash").onclick = () => { menu.hidden = true; log.push("menu-trash"); openDialog(); };
      bar.append(h("button", { "aria-label": "Share" }, "Share"), more, menu);
    } else {
      const trash = h("button", { "aria-label": "Move to trash" }, "🗑");
      trash.onclick = () => { log.push("toolbar-trash"); openDialog(); };
      bar.append(trash, more, menu);
    }
  }

  /** Google archives without asking; the tiles leave the timeline but stay in albums. */
  function archive(how) {
    log.push(how);
    const gone = new Set(selected);
    selected.clear();
    fetch("/__mock/trash", { method: "POST", body: JSON.stringify({ ids: [...gone], from: "grid", action: "archive" }) });
    updateBar();
    paint(true);
    if (album) return;
    setTimeout(() => {
      for (let i = items.length - 1; i >= 0; i -= 1) if (gone.has(items[i].id)) items.splice(i, 1);
      log.push(`archived:${gone.size}`);
      paint(true);
    }, 500);
  }

  // ?verify=1: Google asks the user to verify it's them first, which Sweep must leave alone.
  function openLockDialog() {
    const verify = params.get("verify");
    const dialog = h("div", { role: "dialog", id: "dialog" },
      h("p", {}, verify ? "Verify it's you" : `Move ${selected.size} items to Locked Folder? They won't appear in your library, albums or shared albums.`),
      h("button", { id: "cancel" }, "Cancel"),
      h("button", { id: "confirm" }, verify ? "Next" : "Move"));
    dialog.querySelector("#cancel").onclick = () => { log.push("cancel"); dialog.remove(); };
    dialog.querySelector("#confirm").onclick = () => {
      log.push(verify ? "VERIFY-PRESSED" : "lock-confirm");
      dialog.remove();
      if (verify) return;
      const gone = new Set(selected);
      selected.clear();
      fetch("/__mock/trash", { method: "POST", body: JSON.stringify({ ids: [...gone], from: "grid", action: "lock" }) });
      updateBar();
      setTimeout(() => {
        for (let i = items.length - 1; i >= 0; i -= 1) if (gone.has(items[i].id)) items.splice(i, 1);
        log.push(`locked:${gone.size}`);
        paint(true);
      }, 800);
    };
    document.body.append(dialog);
  }

  function openDialog() {
    if (params.get("deaf")) return;
    const permanent = params.get("confirm") === "permanent";
    const dialog = h("div", { role: "dialog", id: "dialog" },
      h("p", {}, permanent ? "Delete permanently? These items aren't backed up." : "Remove from your Google Account, synced devices and places it's shared?"),
      h("button", { id: "cancel" }, "Cancel"),
      h("button", { id: "confirm" }, permanent ? "Delete permanently" : "Move to trash"));
    dialog.querySelector("#cancel").onclick = () => { log.push("cancel"); dialog.remove(); };
    dialog.querySelector("#confirm").onclick = () => {
      log.push(permanent ? "PERMANENT" : "confirm");
      dialog.remove();
      const gone = new Set(selected);
      selected.clear();
      fetch("/__mock/trash", { method: "POST", body: JSON.stringify({ ids: [...gone], from: "grid" }) });
      updateBar();
      // Google removes the tiles a moment after the dialog closes.
      setTimeout(() => {
        for (let i = items.length - 1; i >= 0; i -= 1) if (gone.has(items[i].id)) items.splice(i, 1);
        log.push(`trashed:${gone.size}`);
        paint(true);
      }, 800);
    };
    document.body.append(dialog);
  }

  document.addEventListener("keydown", (event) => {
    if (event.key === "#" && selected.size) { log.push("hash"); openDialog(); }
    if (event.key === "A" && event.shiftKey && selected.size) archive("shift-a");
    if (event.key === "Escape") document.querySelectorAll("[role=menu]").forEach((menu) => { menu.hidden = true; });
  });

  // ?lag=1 behaves more like Google: a few screens of tiles stay rendered off-screen, and
  // after a jump the old tiles linger while the new ones take a moment to arrive.
  const lag = params.has("lag");
  const BUFFER = lag ? 3 * Math.ceil(900 / SIZE) : 1;
  let painted = "";
  let lagTimer = 0;
  function paint(force = false) {
    spacer.style.height = `${Math.ceil(items.length / COLS) * SIZE}px`;
    if (lag && !force) {
      clearTimeout(lagTimer);
      lagTimer = setTimeout(() => render(false), 350);
      return;
    }
    render(force);
  }
  function render(force) {
    const first = Math.max(0, Math.floor(scroll.scrollTop / SIZE) - BUFFER) * COLS;
    const last = Math.min(items.length, (Math.ceil((scroll.scrollTop + scroll.clientHeight) / SIZE) + BUFFER) * COLS);
    const key = `${first}:${last}:${items.length}`;
    if (key === painted && !force) return;
    painted = key;
    spacer.replaceChildren(...items.slice(first, last).map((item, offset) => {
      const index = first + offset;
      const href = album ? `./album/MOCK/photo/${item.id}` : `./photo/${item.id}`;
      // Like Google, off-screen tiles in the render buffer only get their thumbnail when near.
      const top = Math.floor(index / COLS) * SIZE;
      const near = !lag || (top + SIZE > scroll.scrollTop - SIZE && top < scroll.scrollTop + scroll.clientHeight + SIZE);
      const link = h("a", { href, "aria-label": item.label }, near ? h("img", { src: `https://lh3.googleusercontent.com/pw/${item.id}=w256-h256-no`, alt: "" }) : "");
      const box = h("div", { role: "checkbox", "aria-checked": String(selected.has(item.id)), "aria-label": "Select" });
      box.onclick = () => {
        if (selected.has(item.id)) selected.delete(item.id);
        else selected.add(item.id);
        box.setAttribute("aria-checked", String(selected.has(item.id)));
        updateBar();
      };
      const tile = h("div", { class: "tile" }, link, box);
      Object.assign(tile.style, { top: `${Math.floor(index / COLS) * SIZE}px`, left: `${(index % COLS) * SIZE}px` });
      return tile;
    }));
  }
  scroll.addEventListener("scroll", () => paint());
  paint();
})();

// A single photo's page. Live photos have a trash button; items already in Trash show
// Restore and a permanent Delete (which Sweep must never press); unknown ids show nothing.
function photoPage({ id, status, confirm, deaf, verify }) {
  const h = (tag, attrs = {}, ...children) => {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
    element.append(...children);
    return element;
  };
  const log = [];
  window.__mock = { log, state: () => ({ log: [...log] }) };
  const bar = h("div", { id: "bar" });
  document.body.append(bar);
  if (status === "missing") {
    document.body.append(h("p", {}, "Photo not found"));
    return;
  }
  document.body.append(h("img", { src: `https://lh3.googleusercontent.com/pw/${id}=w600-h600-no`, alt: "" }));
  if (status === "trashed") {
    const restore = h("button", { "aria-label": "Restore" }, "Restore");
    const remove = h("button", { "aria-label": "Delete" }, "Delete");
    remove.onclick = () => document.body.append(h("div", { role: "dialog" }, h("p", {}, "PERMANENT-DELETE-ASKED")));
    bar.append(restore, remove);
    return;
  }
  // The viewer's ⋮ menu: Archive (Unarchive once archived) and Move to Locked Folder.
  let isArchived = status === "archived";
  const menu = h("div", { role: "menu", hidden: "" });
  const buildMenu = () => {
    const archiveItem = h("div", { role: "menuitem" }, isArchived ? "Unarchive" : "Archive");
    archiveItem.onclick = async () => {
      menu.hidden = true;
      if (isArchived) return log.push("UNARCHIVED");
      await fetch("/__mock/trash", { method: "POST", body: JSON.stringify({ ids: [id], from: "photo", action: "archive" }) });
      isArchived = true;
      buildMenu();
    };
    const lockItem = h("div", { role: "menuitem" }, "Move to Locked Folder");
    lockItem.onclick = () => {
      menu.hidden = true;
      const dialog = h("div", { role: "dialog" },
        h("p", {}, verify ? "Verify it's you" : "Move to Locked Folder?"),
        h("button", { id: "cancel" }, "Cancel"),
        h("button", { id: "confirm" }, verify ? "Next" : "Move"));
      dialog.querySelector("#cancel").onclick = () => dialog.remove();
      dialog.querySelector("#confirm").onclick = async () => {
        dialog.remove();
        if (verify) return;
        await fetch("/__mock/trash", { method: "POST", body: JSON.stringify({ ids: [id], from: "photo", action: "lock" }) });
        setTimeout(() => history.pushState({}, "", "/"), 300);
      };
      document.body.append(dialog);
    };
    menu.replaceChildren(archiveItem, lockItem);
  };
  buildMenu();
  const more = h("button", { "aria-label": "More options" }, "⋮");
  more.onclick = () => { menu.hidden = !menu.hidden; };
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") menu.hidden = true; });

  const trash = h("button", { "aria-label": "Delete" }, "🗑");
  trash.onclick = () => {
    if (deaf) return;
    const dialog = h("div", { role: "dialog" },
      h("p", {}, confirm === "permanent" ? "Delete permanently?" : "Move to trash?"),
      h("button", { id: "cancel" }, "Cancel"),
      h("button", { id: "confirm" }, confirm === "permanent" ? "Delete permanently" : "Move to trash"));
    dialog.querySelector("#cancel").onclick = () => dialog.remove();
    dialog.querySelector("#confirm").onclick = async () => {
      dialog.remove();
      await fetch("/__mock/trash", { method: "POST", body: JSON.stringify({ ids: [id], from: "photo" }) });
      // Google moves on to the next photo (here: back to the grid) without a full reload.
      setTimeout(() => history.pushState({}, "", "/"), 300);
    };
    document.body.append(dialog);
  };
  bar.append(trash, more, menu);
}
