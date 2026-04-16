
// PATCH VISIBILITY FIX - v0.6.11

export function addLayers(map, geojson) {
  if (!map.getSource("grid")) {
    map.addSource("grid", {
      type: "geojson",
      data: geojson
    });
  }

  // FORCE update
  map.getSource("grid").setData(geojson);
  console.log("setData called", geojson.features.length);

  // REMOVE existing layer if exists (clean state)
  if (map.getLayer("grid-fill")) {
    map.removeLayer("grid-fill");
  }

  // DEBUG SAFE LAYER (VISIBLE)
  map.addLayer({
    id: "grid-fill",
    type: "fill",
    source: "grid",
    paint: {
      "fill-color": "#ff0000",
      "fill-opacity": 0.6
    }
  });

  console.log("grid-fill added");
}
