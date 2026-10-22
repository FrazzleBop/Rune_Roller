import OBR, { buildText } from "https://cdn.jsdelivr.net/npm/@owlbear-rodeo/sdk@3/+esm";

const ICON = new URL("icon.svg", import.meta.url).href;

const ID = "com.example.rune-roller";
const RUNE_KEY = `${ID}/isRune`;      // item metadata: marks an item as a rune
const HOLD_KEY = `${ID}/holding`;     // player metadata: id of the rune being held
const ROLL_CHANNEL = `${ID}/roll`;
const TOOL_ID = `${ID}/tool`;
const REQUIRED_PLAYERS = 5;

console.log("[Rune Roller] main.js loaded, SDK imported");

OBR.onReady(async () => {
  console.log("[Rune Roller] OBR ready, registering tool and menu");
  const selfId = await OBR.player.getId();
  let party = await OBR.party.getPlayers();       // everyone except me
  let me = { id: selfId, name: await OBR.player.getName(), metadata: await OBR.player.getMetadata() };
  const fired = new Set();                        // runes that already rolled during the current hold

  /* ---------- 1. GM/anyone marks items as runes via right-click menu ---------- */
  OBR.contextMenu.create({
    id: `${ID}/context`,
    icons: [
      {
        icon: ICON,
        label: "Make Rune",
        filter: { every: [{ key: ["metadata", RUNE_KEY], value: undefined }], permissions: ["UPDATE"] },
      },
      {
        icon: ICON,
        label: "Remove Rune",
        filter: { every: [{ key: ["metadata", RUNE_KEY], value: true }], permissions: ["UPDATE"] },
      },
    ],
    onClick(context) {
      const makeRune = context.items.every((i) => !i.metadata[RUNE_KEY]);
      OBR.scene.items.updateItems(context.items, (items) => {
        for (const item of items) {
          if (makeRune) item.metadata[RUNE_KEY] = true;
          else delete item.metadata[RUNE_KEY];
        }
      });
    },
  });

  /* ---------- 2. Tool: hold left mouse button on a rune ---------- */
  const setHolding = (runeId) => {
    if (runeId) console.log("[Rune Roller] holding rune", runeId);
    return OBR.player.setMetadata({ [HOLD_KEY]: runeId });
  };

  OBR.tool.create({
    id: TOOL_ID,
    icons: [{ icon: ICON, label: "Hold Rune" }],
  });

  OBR.tool.createMode({
    id: `${ID}/mode`,
    icons: [{ icon: ICON, label: "Hold Rune", filter: { activeTools: [TOOL_ID] } }],
    preventDrag: { dragging: true },
    onToolDown(_ctx, event) {
      const target = event.target;
      if (target && target.metadata[RUNE_KEY]) setHolding(target.id);
    },
    onToolMove(_ctx, event) {
      // Pointer slid off the rune -> no longer holding it
      if (me.metadata[HOLD_KEY] && event.target?.id !== me.metadata[HOLD_KEY]) setHolding(null);
    },
    onToolUp() { setHolding(null); },
    onToolDragEnd() { setHolding(null); },
    onToolDragCancel() { setHolding(null); },
  });

  // Switching tools releases the hold
  OBR.tool.onToolChange(() => setHolding(null));
  window.addEventListener("beforeunload", () => setHolding(null));

  console.log("[Rune Roller] tool and menu registered");

  /* ---------- 3a. Floating "✋ 3/5" indicator above each held rune ---------- */
  // Local items are drawn only on this client; every client computes the same count,
  // so everyone sees the same indicator without writing anything to the scene.
  const shown = new Map();            // runeId -> count currently displayed
  let indicatorQueue = Promise.resolve();
  const indicatorId = (runeId) => `${ID}/indicator/${runeId}`;

  function updateIndicators(byRune) {
    const counts = new Map([...byRune].map(([runeId, holders]) => [runeId, holders.length]));
    indicatorQueue = indicatorQueue.then(async () => {
      try {
        if (!(await OBR.scene.isReady())) {
          console.warn("[Rune Roller] scene not ready, skipping indicator");
          return;
        }

        // Remove indicators for runes nobody is holding any more
        const stale = [...shown.keys()].filter((runeId) => !counts.has(runeId));
        if (stale.length) {
          await OBR.scene.local.deleteItems(stale.map(indicatorId));
          stale.forEach((runeId) => shown.delete(runeId));
        }

        // Add or refresh indicators whose count changed
        for (const [runeId, count] of counts) {
          if (shown.get(runeId) === count) continue;
          try {
            const bounds = await OBR.scene.items.getItemBounds([runeId]);
            const ready = count >= REQUIRED_PLAYERS;
            const width = 160;
            const height = 56;
            const label = buildText()
              .id(indicatorId(runeId))
              .plainText(`✋ ${count}/${REQUIRED_PLAYERS}`)
              .position({ x: bounds.center.x - width / 2, y: bounds.min.y - height - 10 })
              .width(width)
              .height(height)
              .fontSize(36)
              .textAlign("CENTER")
              .textAlignVertical("MIDDLE")
              .fillColor(ready ? "#7CFC9A" : "#FFFFFF")
              .strokeColor("#000000")
              .strokeWidth(3)
              .layer("TEXT")
              .locked(true)
              .disableHit(true)
              .build();
            await OBR.scene.local.deleteItems([indicatorId(runeId)]);
            await OBR.scene.local.addItems([label]);
            shown.set(runeId, count);
          } catch (err) {
            console.warn("[Rune Roller] indicator failed for rune", runeId, err);
            shown.delete(runeId);
          }
        }
      } catch (err) {
        console.warn("Rune indicator update failed", err);
      }
    });
  }

  /* ---------- 3. Count holders and roll ---------- */
  function evaluate() {
    const everyone = [...party, me];
    const byRune = new Map();
    for (const p of everyone) {
      const rune = p.metadata?.[HOLD_KEY];
      if (!rune) continue;
      if (!byRune.has(rune)) byRune.set(rune, []);
      byRune.get(rune).push(p);
    }

    console.log("[Rune Roller] holders:", [...byRune].map(([id, h]) => `${id.slice(0, 6)}: ${h.length}`));
    updateIndicators(byRune);

    // Re-arm runes that dropped below the threshold
    for (const runeId of [...fired]) {
      if ((byRune.get(runeId)?.length ?? 0) < REQUIRED_PLAYERS) fired.delete(runeId);
    }

    for (const [runeId, holders] of byRune) {
      if (holders.length < REQUIRED_PLAYERS || fired.has(runeId)) continue;
      // Only one client rolls: the holder with the lowest id
      const roller = holders.map((h) => h.id).sort()[0];
      if (roller !== selfId) continue;

      fired.add(runeId);
      const roll = Math.floor(Math.random() * 20) + 1;
      OBR.broadcast.sendMessage(
        ROLL_CHANNEL,
        { runeId, roll, names: holders.map((h) => h.name) },
        { destination: "ALL" }
      );
    }
  }

  OBR.party.onChange((players) => { party = players; evaluate(); });
  OBR.player.onChange((player) => { me = player; evaluate(); });

  /* ---------- 4. Sync roll state ---------- */
  // Every client marks the rune as already rolled so a second roll can't fire
  // if the roller changes mid-hold. (The roll result is no longer displayed.)
  OBR.broadcast.onMessage(ROLL_CHANNEL, (event) => {
    fired.add(event.data.runeId);
  });
});
