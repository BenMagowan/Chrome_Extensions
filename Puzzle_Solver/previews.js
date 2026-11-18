/*
 * Registry for the board previews. Each games/<id>/preview.js calls
 * registerPreview(id, factory); popup.js calls makePreview(id, boardEl) for the
 * game in the active tab. A factory returns { renderPlaceholder(), renderBoard(b) },
 * where `b` is that game's detect result.
 */
const PREVIEW_FACTORIES = {};

function registerPreview(id, factory) {
  PREVIEW_FACTORIES[id] = factory;
}

function makePreview(id, boardEl) {
  const factory = PREVIEW_FACTORIES[id];
  return factory ? factory(boardEl) : null;
}
