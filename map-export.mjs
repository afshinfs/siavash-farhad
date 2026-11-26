export function saveFile(blob, name) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 30000);
}

function canvas(width, height) {
  const image = document.createElement('canvas');
  image.width = width;
  image.height = height;
  return image;
}

function gridProjection(grid) {
  const epsg = Number((grid.crsCode || grid.crs).split(':').pop());
  const utm = '+proj=utm +zone=' + (epsg % 100) + (epsg >= 32700 ? ' +south' : '') + ' +datum=WGS84 +units=m';
  return window.proj4('EPSG:4326', utm);
}

function paintLines(ctx, features, project, color) {
  for (const feature of features ?? []) {
    const {type, coordinates} = feature.geometry;
    const lines = type === 'MultiLineString' ? coordinates : type === 'LineString' ? [coordinates] : [];
    ctx.strokeStyle = color(feature);
    ctx.beginPath();
    for (const line of lines) line.forEach((point, i) => ctx[i ? 'lineTo' : 'moveTo'](...project(point)));
    ctx.stroke();
  }
}

export function exportMapImage({canvas: source, grid, rivers, stripeColor, vectors, vectorColor}, bounds) {
  const t = grid && (grid.affineTransform || grid.transform);
  const projection = grid && (bounds || rivers?.length) ? gridProjection(grid) : null;
  const aspect = bounds ? (bounds.east-bounds.west)*Math.cos((bounds.north+bounds.south)*Math.PI/360)/(bounds.north-bounds.south)
    : source.width*Math.abs(t.scaleX)/(source.height*Math.abs(t.scaleY));
  const maxSize = bounds ? 750 : 1200;
  const width = Math.max(1, Math.round(maxSize*Math.min(1,aspect)));
  const height = Math.max(1, Math.round(maxSize*Math.min(1,1/aspect)));
  const image = canvas(width, height), ctx = image.getContext('2d');
  const mapPoint = bounds ? ([lon,lat]) => [(lon-bounds.west)/(bounds.east-bounds.west)*width, (bounds.north-lat)/(bounds.north-bounds.south)*height]
    : point => {
      const [x,y] = projection.forward(point);
      return [(x-t.translateX)/t.scaleX*width/source.width,(y-t.translateY)/t.scaleY*height/source.height];
    };
  if (source) {
    const pixels = source.getContext('2d').getImageData(0,0,source.width,source.height).data;
    const result = ctx.createImageData(width,height);
    for (let row=0;row<height;row++) for (let col=0;col<width;col++) {
      const [gx,gy] = bounds ? projection.forward([
        bounds.west+(col+.5)/width*(bounds.east-bounds.west),
        bounds.north-(row+.5)/height*(bounds.north-bounds.south),
      ]) : [t.translateX+(col+.5)*source.width/width*t.scaleX,t.translateY+(row+.5)*source.height/height*t.scaleY];
      const x=Math.floor((gx-t.translateX)/t.scaleX), y=Math.floor((gy-t.translateY)/t.scaleY);
      if (x<0 || x>=source.width || y<0 || y>=source.height) continue;
      const from=(y*source.width+x)*4, to=(row*width+col)*4;
      if (stripeColor && pixels[from+3] && stripeColor.every((v,i)=>v===pixels[from+i]) && (col+row)%12<6) {
        result.data.set([255,255,255,255], to);
      } else {
        result.data[to]=pixels[from];
        result.data[to+1]=pixels[from+1];
        result.data[to+2]=pixels[from+2];
        result.data[to+3]=pixels[from+3];
      }
    }
    ctx.putImageData(result,0,0);
  }
  ctx.lineWidth=3;
  paintLines(ctx,rivers,mapPoint,()=> '#1686b6');
  paintLines(ctx,vectors,mapPoint,vectorColor);
  return image;
}

export function mapLegend(element) {
  if (!element) return [];
  const legend = element.matches('.range-legend') ? element : element.querySelector('.range-legend');
  if (legend) {
    const ticks = [...legend.querySelectorAll('.range-ticks > span')].map(node => node.textContent.trim()).join(' / ');
    const label = legend.firstChild.textContent.trim();
    const colors = legend.querySelector('.range-bar')?.style.background.match(/#[a-f\d]{6}|rgb\([^)]+\)/gi) ?? [];
    return [{label: [label,ticks].filter(Boolean).join(' · '), colors}];
  }
  return [...element.childNodes].flatMap(node => {
    const label = node.textContent.trim();
    if (!label) return [];
    const key = node.querySelector?.('i,.hazard-swatch');
    return [{label, colors: key ? [key.style.backgroundColor || (label === 'River' ? '#1686b6' : '#f8de70')] : [], striped: label === 'Residual'}];
  });
}

export function exportLegend(view) {
  const siblings = [...view.parentElement.children];
  const legend = siblings.find(node => node.matches('.map-legend,.range-legend'));
  return mapLegend(legend);
}

export function mapDownloads(container, {name, title, tiff, view, legend}) {
  const actions = document.createElement('div');
  actions.className = 'terrain-downloads';
  for (const format of ['GeoTIFF','PNG']) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary';
    button.textContent = 'Download ' + format;
    button.setAttribute('aria-label', 'Download ' + title + ' ' + format);
    actions.append(button);
    button.onclick = async () => {
      if (format === 'GeoTIFF') {
        saveFile(new Blob([tiff], {type:'image/tiff'}), name+'.tif');
        return;
      }
      const original = button.textContent;
      button.disabled = true;
      try {
        const map = exportMapImage(view());
        const entries = mapLegend(legend);
        const output = canvas(Math.max(map.width+48,800),map.height+110+29*entries.length);
        const ctx = output.getContext('2d');
        ctx.fillStyle='#fff'; ctx.fillRect(0,0,output.width,output.height);
        ctx.fillStyle='#183b35'; ctx.font='bold 28px sans-serif'; ctx.fillText(title,24,42,output.width-48);
        ctx.drawImage(map,(output.width-map.width)/2,65);
        ctx.strokeStyle='#aebfba';ctx.strokeRect((output.width-map.width)/2,65,map.width,map.height);
        ctx.font='18px sans-serif';
        entries.forEach(({label,colors,striped},i) => {
          const y = map.height+86+29*i;
          paintLegendKey(ctx,colors,striped,24,y,32,14);
          ctx.fillStyle='#183b35';ctx.fillText(label,66,y+13,output.width-90);
        });
        const blob = await new Promise(resolve => output.toBlob(resolve,'image/png'));
        if (!blob) throw Error('PNG encoding failed.');
        saveFile(blob,name+'.png');
        button.textContent = original;
      } catch (error) {
        button.textContent = 'Retry PNG download';
        button.title = error.message;
      } finally {
        button.disabled = false;
      }
    };
  }
  container.replaceChildren(actions);
}

export function paintLegendKey(ctx, colors, striped, x, y, width, height) {
  if (!colors.length) return;
  if (colors.length > 1) {
    const gradient = ctx.createLinearGradient(x,0,x+width,0);
    colors.forEach((color,i) => gradient.addColorStop(i/(colors.length-1),color));
    ctx.fillStyle = gradient;
  } else ctx.fillStyle = colors[0];
  ctx.fillRect(x,y,width,height);
  if (!striped) return;
  ctx.save();
  ctx.beginPath();ctx.rect(x,y,width,height);ctx.clip();
  ctx.strokeStyle='#fff';ctx.lineWidth=3;
  for(let dx=-height;dx<width;dx+=8){
    ctx.beginPath();ctx.moveTo(x+dx,y+height);ctx.lineTo(x+dx+height,y);ctx.stroke();
  }
  ctx.restore();
}
