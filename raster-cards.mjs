export function appendRasterCard(container, product, { label, width, height, url, filename }) {
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
  container.append(card);
}
