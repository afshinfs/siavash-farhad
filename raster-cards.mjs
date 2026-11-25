// Each locator uses the georeferencing of its own output, including local DEMs.
export function showStudyArea(parent, grid) {
  const { width, height } = grid.dimensions || grid;
  const t = grid.affineTransform || grid.transform;
  const crs = grid.crsCode || grid.crs;
  const bounds = [t.translateX, t.translateY, t.translateX + width*t.scaleX, t.translateY + height*t.scaleY];
  const key = [crs,...bounds].join(',');
  const previous = parent.querySelector(':scope > .study-area-locator');
  if (previous?.dataset.grid === key) return;
  previous?.remove();
  const region = document.createElement('div');
  region.className = 'study-area-locator ee-help';
  region.dataset.grid = key;
  const label = document.createElement('strong');
  label.textContent = 'Study area';
  region.append(label);
  parent.append(region);
  const epsg = Number(crs.split(':').pop());
  if (!window.proj4) {
    region.append(document.createElement('br'), crs + ' · ' + bounds.join(', '));
    return;
  }
  const utm = '+proj=utm +zone=' + (epsg % 100) + (epsg >= 32700 ? ' +south' : '') + ' +datum=WGS84 +units=m';
  const corners = [[bounds[0],bounds[1]],[bounds[2],bounds[1]],[bounds[2],bounds[3]],[bounds[0],bounds[3]]]
    .map(point => window.proj4(utm,'EPSG:4326',point));
  const xs = corners.map(p=>p[0]), ys = corners.map(p=>p[1]);
  const west=Math.min(...xs), east=Math.max(...xs), south=Math.min(...ys), north=Math.max(...ys);
  const lat=(north+south)/2, lon=(east+west)/2;
  const frame = document.createElement('iframe');
  frame.title = 'Study area map centred at ' + lat.toFixed(4) + ', ' + lon.toFixed(4);
  frame.loading = 'lazy';
  frame.style.cssText='display:block;width:100%;height:165px;border:0;margin-top:5px';
  const params = new URLSearchParams({bbox:[west,south,east,north].join(','),layer:'mapnik',marker:lat+','+lon});
  frame.src = 'https://www.openstreetmap.org/export/embed.html?' + params;
  region.append(frame, 'Grid centre · ' + lat.toFixed(4) + '°, ' + lon.toFixed(4) + '°');
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
