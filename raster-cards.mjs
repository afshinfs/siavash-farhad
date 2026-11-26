// Reproject the display pixels to Web Mercator. The source canvas and exported
// GeoTIFF retain the native grid. Nearest-neighbour keeps categorical colours.
function rasterImage(canvas, grid, projection, [west, south, east, north], stripeColor) {
  const source = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  const image = document.createElement('canvas');
  const scale = stripeColor ? Math.max(4, 384 / Math.max(canvas.width, canvas.height)) : 2;
  image.width = Math.min(1024, Math.ceil(canvas.width * scale));
  image.height = Math.min(1024, Math.ceil(canvas.height * scale));
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
      const rgba = source.data.subarray(offset, offset + 4);
      const pixel = (row * image.width + col) * 4;
      if (stripeColor && rgba[3] && stripeColor.every((value, channel) => rgba[channel] === value)) {
        const white = (row + col) % 8 < 4;
        target.data.set(white ? [255, 255, 255, 255] : [...stripeColor, 255], pixel);
      } else target.data.set(rgba, pixel);
    }
  }
  context.putImageData(target, 0, 0);
  return image.toDataURL();
}

class StudyAreaMap extends HTMLElement {
  connectedCallback() {
    this.onLibrariesReady = () => {
      if (this.inView) this.render();
    };
    window.addEventListener('study-map-libraries-ready', this.onLibrariesReady);
    this.observer = new IntersectionObserver(([entry]) => {
      this.inView = entry.isIntersecting;
      if (this.inView) this.render();
    });
    this.observer.observe(this);
  }

  disconnectedCallback() {
    this.observer.disconnect();
    window.removeEventListener('study-map-libraries-ready', this.onLibrariesReady);
    this.map?.remove();
    this.map = null;
    this.overlay = null;
    this.riverLayer = null;
    this.drawnRivers = null;
    this.dirty = true;
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
      this.map.createPane('river-lines').style.zIndex = '450';
      this.map.createPane('study-outline').style.zIndex = '460';
      L.polygon(points, { pane: 'study-outline', color: '#243e4a', weight: 2, fill: false, interactive: false }).addTo(this.map);
      this.map.fitBounds(L.latLngBounds(points), { padding: [20, 20], maxZoom: 19 });
    }
    this.map.invalidateSize({ pan: false });
    if (this.rivers !== this.drawnRivers) {
      this.riverLayer?.remove();
      this.riverLayer = this.rivers?.length ? L.geoJSON(this.rivers, {
        pane: 'river-lines', interactive: false,
        style: { color: '#1686b6', weight: 3, opacity: 0.95 },
      }).addTo(this.map) : null;
      this.drawnRivers = this.rivers;
    }
    if (!canvas || !this.dirty) return;

    const [west, south, east, north] = extent;
    const bounds = L.latLngBounds([
      L.CRS.EPSG3857.unproject(L.point(west, south)),
      L.CRS.EPSG3857.unproject(L.point(east, north)),
    ]);
    const url = rasterImage(canvas, grid, projection, extent, this.stripeColor);
    if (this.overlay) this.overlay.setUrl(url);
    else this.overlay = L.imageOverlay(url, bounds, { opacity: 0.83, className: 'study-area-raster' }).addTo(this.map);
    canvas.hidden = true;
    this.dirty = false;
  }
}

customElements.define('study-area-map', StudyAreaMap);

export function showStudyArea(parent, grid, canvas = parent.querySelector(':scope > canvas'), { rivers = null, stripeColor } = {}) {
  let view = parent.querySelector(':scope > study-area-map');
  if (view && view.grid !== grid) {
    if (canvas && view.contains(canvas)) {
      canvas.hidden = false;
      view.before(canvas);
    }
    view.remove();
    view = null;
  }
  if (!view) {
    view = document.createElement('study-area-map');
    view.grid = grid;
    view.setAttribute('aria-label', canvas?.getAttribute('aria-label') || 'Study area');
    if (canvas) {
      canvas.before(view);
      view.append(canvas);
    } else parent.append(view);
  }
  view.canvas = canvas;
  view.rivers = rivers;
  view.stripeColor = stripeColor;
  view.setAttribute('aria-label', canvas?.getAttribute('aria-label') || 'Study area');
  view.dirty = true;
  if (view.map) view.render();
}

export function appendRiverLegend(legend, rivers) {
  if (!rivers?.length) return;
  const item = document.createElement('span'), swatch = document.createElement('i');
  swatch.className = 'river-legend-line';
  item.append(swatch, 'River');
  legend.append(item);
}

const worldCover = [
  ['Tree cover','#006400'], ['Shrubland','#ffbb22'], ['Grassland','#ffff4c'],
  ['Cropland','#f096ff'], ['Built-up','#fa0000'], ['Bare or sparse vegetation','#b4b4b4'],
  ['Snow and ice','#f0f0f0'], ['Permanent water','#0064c8'], ['Herbaceous wetland','#0096a0'],
  ['Mangroves','#00cf75'], ['Moss and lichen','#fae6a0'],
];
const soil = [['Group A','#50b4eb'],['Group B','#64be64'],['Group C','#ebb93c'],['Group D','#af5541']];
const directions = ['Outlet','East','Southeast','South','Southwest','West','Northwest','North','Northeast'];
const directionColors = ['#8e8e8e','#d73027','#fc8d59','#fee090','#91cf60','#1a9850','#3288bd','#5149a4','#b358a5'];
const fmt = value => value.toLocaleString(undefined,{maximumSignificantDigits:4});

export function rangeLegend(min, max, unit, start='#285752', end='#e6e0a2', log=false) {
  const legend = document.createElement('span');
  legend.className = 'range-legend';
  const bar = document.createElement('span');
  bar.className = 'range-bar';
  bar.style.background = min === max ? 'color-mix(in srgb,'+start+' 50%, '+end+')' : 'linear-gradient(to right,'+start+','+end+')';
  const ticks = document.createElement('span');
  ticks.className = 'range-ticks';
  const mid = log ? min + Math.expm1(Math.log1p(max-min)/2) : (min+max)/2;
  for (const value of min === max ? [min] : [min,mid,max]) {
    const label = document.createElement('span');
    label.textContent = fmt(value);
    ticks.append(label);
  }
  legend.append(unit + (log ? ' · logarithmic scale' : ''),bar,ticks);
  return legend;
}

function categoricalLegend(entries) {
  const legend = document.createElement('div');
  legend.className = 'map-legend';
  for (const [label,color] of entries) {
    const item = document.createElement('span'), swatch = document.createElement('i');
    swatch.style.backgroundColor=color;
    item.append(swatch,label);
    legend.append(item);
  }
  return legend;
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
    const categories = product.name === 'lulc' ? worldCover : product.name === 'hsg_proxy' ? soil
      : product.name === 'flow_direction' ? directions.map((label,i)=>[label,directionColors[i]])
      : ['building_presence_proxy','building_footprint_mask'].includes(product.name)
        ? [['No mapped building','#285752'],['Building present','#e6e0a2']] : null;
    card.append(categories ? categoricalLegend(categories) : rangeLegend(min,max,unit || label,undefined,undefined,product.name === 'flowacc'));
    showStudyArea(card, grid, canvas);
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

  container.append(card);
}
