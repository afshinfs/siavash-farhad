// Reproject the display pixels to Web Mercator. The source canvas and exported
// GeoTIFF retain the native grid. Nearest-neighbour keeps categorical colours.
function rasterImage(canvas, grid, projection, [west, south, east, north]) {
  const source = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  const image = document.createElement('canvas');
  image.width = Math.min(1024, canvas.width * 2);
  image.height = Math.min(1024, canvas.height * 2);
  const context = image.getContext('2d');
  const target = context.createImageData(image.width, image.height);
  const t = grid.affineTransform || grid.transform;
  for (let row = 0; row < image.height; row++) {
    const y = north - (row + 0.5) * (north - south) / image.height;
    for (let col = 0; col < image.width; col++) {
      const x = west + (col + 0.5) * (east - west) / image.width;
      const [easting, northing] = projection.inverse([x, y]);
      const i = Math.floor((easting - t.translateX) / t.scaleX);
      const j = Math.floor((northing - t.translateY) / t.scaleY);
      if (i < 0 || i >= canvas.width || j < 0 || j >= canvas.height) continue;
      const offset = (j * canvas.width + i) * 4;
      target.data.set(source.data.subarray(offset, offset + 4), (row * image.width + col) * 4);
    }
  }
  context.putImageData(target, 0, 0);
  return image.toDataURL();
}

class StudyAreaMap extends HTMLElement {
  connectedCallback() {
    this.observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) this.render();
    });
    this.observer.observe(this);
  }

  disconnectedCallback() {
    this.observer.disconnect();
    this.map?.remove();
    this.map = null;
    this.overlay = null;
  }

  render() {
    const { grid, canvas } = this;
    const { L, proj4 } = window;
    if (!L || !proj4 || !this.clientWidth) return;
    const { width, height } = grid.dimensions || grid;
    const t = grid.affineTransform || grid.transform;
    const epsg = Number((grid.crsCode || grid.crs).split(':').pop());
    const utm = '+proj=utm +zone=' + (epsg % 100) + (epsg >= 32700 ? ' +south' : '') + ' +datum=WGS84 +units=m';
    const projection = proj4(utm, 'EPSG:3857');
    const x = t.translateX, y = t.translateY;
    const right = x + width * t.scaleX, bottom = y + height * t.scaleY;
    const outline = [[x, y], [right, y], [right, bottom], [x, bottom]].map(p => projection.forward(p));
    const points = outline.map(([a, b]) => L.CRS.EPSG3857.unproject(L.point(a, b)));
    const xs = outline.map(p => p[0]), ys = outline.map(p => p[1]);
    const extent = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    if (!extent.every(Number.isFinite)) return;

    if (!this.map) {
      this.map = L.map(this, { scrollWheelZoom: false });
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxNativeZoom: 19, maxZoom: 22,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      }).addTo(this.map);
      L.polygon(points, { color: '#243e4a', weight: 2, fill: false, interactive: false }).addTo(this.map);
      this.map.fitBounds(L.latLngBounds(points), { padding: [20, 20], maxZoom: 19 });
    }
    this.map.invalidateSize({ pan: false });
    if (!canvas || !this.dirty) return;

    const [west, south, east, north] = extent;
    const bounds = L.latLngBounds([
      L.CRS.EPSG3857.unproject(L.point(west, south)),
      L.CRS.EPSG3857.unproject(L.point(east, north)),
    ]);
    const url = rasterImage(canvas, grid, projection, extent);
    if (this.overlay) this.overlay.setUrl(url);
    else this.overlay = L.imageOverlay(url, bounds, { opacity: 0.68, className: 'study-area-raster' }).addTo(this.map);
    canvas.hidden = true;
    this.dirty = false;
  }
}

customElements.define('study-area-map', StudyAreaMap);

export function showStudyArea(parent, grid, canvas = parent.querySelector(':scope > canvas')) {
  let view = parent.querySelector(':scope > study-area-map');
  if (view && view.grid !== grid) {
    view.remove();
    view = null;
  }
  if (!view) {
    view = document.createElement('study-area-map');
    view.grid = grid;
    view.setAttribute('aria-label', canvas?.getAttribute('aria-label') || 'Study area');
    if (canvas) canvas.after(view);
    else parent.append(view);
  }
  view.canvas = canvas;
  view.dirty = true;
  if (view.map) view.render();
}

export function appendRasterCard(container, product, { label, width, height, grid, url, filename }) {
  const card = document.createElement('section');
  card.className = 'raster-card';

  const heading = document.createElement('h4');
  heading.textContent = label;
  heading.id = container.id + '-' + product.name + '-title';
  card.setAttribute('aria-labelledby', heading.id);
  card.append(heading);

  const { min, max, validCells, unit } = product.summary;
  if (validCells) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', label + ' raster preview');
    const pixels = new Uint8ClampedArray(product.preview);
    canvas.getContext('2d').putImageData(new ImageData(pixels, width, height), 0, 0);
    card.append(canvas);
  }
  const summary = document.createElement('p');
  summary.className = 'ee-help';
  const format = value => value.toLocaleString(undefined, { maximumSignificantDigits: 5 });
  summary.textContent = validCells
    ? (min === max ? format(min) : format(min) + ' to ' + format(max)) +
      (unit ? ' ' + unit : '') + ' · ' + validCells.toLocaleString() + ' valid cells'
    : 'No valid cells on this grid.';
  card.append(summary);

  if (url) {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.textContent = 'Download GeoTIFF';
    link.setAttribute('aria-label', 'Download ' + label + ' GeoTIFF');
    card.append(link);
  }
  showStudyArea(card, grid);
  container.append(card);
}
