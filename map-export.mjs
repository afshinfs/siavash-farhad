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

const worldHalf = 20037508.342789244;
const attribution = '© OpenStreetMap contributors · openstreetmap.org/copyright';

function gridProjection(grid) {
  const epsg = Number((grid.crsCode || grid.crs).split(':').pop());
  const utm = '+proj=utm +zone=' + (epsg % 100) + (epsg >= 32700 ? ' +south' : '') + ' +datum=WGS84 +units=m';
  return window.proj4(utm, 'EPSG:3857');
}

function loadTile(zoom,x,y) {
  return new Promise(resolve => {
    const tile = new Image();
    const finish = result => {
      clearTimeout(timer);
      tile.onload = tile.onerror = null;
      if (!result) tile.removeAttribute('src');
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), 8000);
    tile.crossOrigin = 'anonymous';
    tile.onload = () => finish(tile);
    tile.onerror = () => finish(null);
    tile.src = 'https://tile.openstreetmap.org/'+zoom+'/'+x+'/'+y+'.png';
  });
}

let lastBasemap;
function basemap(extent,width,height) {
  const key = [width,height,...extent].join(',');
  if (lastBasemap?.key === key) return lastBasemap.image;
  const image = drawBasemap(extent,width,height);
  lastBasemap = {key,image};
  return image;
}

async function drawBasemap([west,south,east,north],width,height) {
  const image = canvas(width,height), ctx = image.getContext('2d');
  ctx.fillStyle = '#eef3ee';
  ctx.fillRect(0,0,width,height);
  const zoom = Math.max(0,Math.min(19,Math.floor(Math.log2(width*2*worldHalf/((east-west)*256)))));
  const count = 2 ** zoom, size = 2*worldHalf/count;
  const tileX = x => (x+worldHalf)/size;
  const tileY = y => (worldHalf-y)/size;
  const left = tileX(west), right = tileX(east), top = tileY(north), bottom = tileY(south);
  const scaleX = width/(right-left), scaleY = height/(bottom-top);
  const tiles = [];
  for(let y=Math.max(0,Math.floor(top));y<Math.min(count,Math.ceil(bottom));y++) {
    for(let x=Math.floor(left);x<Math.ceil(right);x++) {
      const tx=x,ty=y;
      tiles.push(loadTile(zoom,((x%count)+count)%count,y).then(tile=>{
        if (tile) {
          const x0=Math.round((tx-left)*scaleX), y0=Math.round((ty-top)*scaleY);
          ctx.drawImage(tile,x0,y0,Math.round((tx+1-left)*scaleX)-x0,Math.round((ty+1-top)*scaleY)-y0);
        }
        return Boolean(tile);
      }));
    }
  }
  const loaded=(await Promise.all(tiles)).filter(Boolean).length;
  return {image,credit:!loaded ? 'Basemap unavailable' :
    loaded===tiles.length ? attribution : attribution+' · Some map tiles unavailable'};
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

export async function exportMapImage({canvas: source, grid, rivers, stripeColor, vectors, vectorColor}, bounds) {
  const t = grid && (grid.affineTransform || grid.transform);
  const projection = grid ? gridProjection(grid) : null;
  const geographic = window.proj4('EPSG:4326','EPSG:3857');
  let outline;
  if (!bounds) {
    const left=t.translateX, top=t.translateY;
    const right=left+source.width*t.scaleX, bottom=top+source.height*t.scaleY;
    outline=[[left,top],[right,top],[right,bottom],[left,bottom]].map(point=>projection.forward(point));
  }
  const points = outline ?? [geographic.forward([bounds.west,bounds.south]),geographic.forward([bounds.east,bounds.north])];
  const xs=points.map(point=>point[0]), ys=points.map(point=>point[1]);
  const west=Math.min(...xs),east=Math.max(...xs),south=Math.min(...ys),north=Math.max(...ys);
  const aspect=(east-west)/(north-south);
  const maxSize = bounds ? 750 : 1200;
  const width = Math.max(1, Math.round(maxSize*Math.min(1,aspect)));
  const height = Math.max(1, Math.round(maxSize*Math.min(1,1/aspect)));
  const image = canvas(width, height), ctx = image.getContext('2d');
  const base=await basemap([west,south,east,north],width,height);
  ctx.drawImage(base.image,0,0);
  image.basemapCredit=base.credit;
  const screenPoint = ([x,y]) => [(x-west)/(east-west)*width,(north-y)/(north-south)*height];
  const mapPoint = point => screenPoint(geographic.forward(point));
  if (source) {
    const pixels = source.getContext('2d').getImageData(0,0,source.width,source.height).data;
    const result = ctx.createImageData(width,height);
    for (let row=0;row<height;row++) for (let col=0;col<width;col++) {
      const [gx,gy] = projection.inverse([
        west+(col+.5)/width*(east-west), north-(row+.5)/height*(north-south),
      ]);
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
    const overlay=canvas(width,height);
    overlay.getContext('2d').putImageData(result,0,0);
    ctx.globalAlpha=.83;
    ctx.drawImage(overlay,0,0);
    ctx.globalAlpha=1;
  }
  ctx.lineWidth=3;
  paintLines(ctx,rivers,mapPoint,()=> '#1686b6');
  paintLines(ctx,vectors,mapPoint,vectorColor);
  if (outline) {
    ctx.strokeStyle='#243e4a';
    ctx.lineWidth=2;
    ctx.beginPath();
    outline.forEach((point,i)=>ctx[i?'lineTo':'moveTo'](...screenPoint(point)));
    ctx.closePath();
    ctx.stroke();
  }
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

// Fill each row left to right. The tallest label determines the row height.
export function legendLayout(entries,width,gap,keyWidth,lineHeight,rowGap,wrap) {
  const columns = Math.min(entries.length || 1,entries.length >= 6 ? 3 : 2);
  const columnWidth = (width-(columns-1)*gap)/columns;
  const cells=[];
  let y=0;
  for(let i=0;i<entries.length;i+=columns) {
    let tallest=0;
    for(const [column,entry] of entries.slice(i,i+columns).entries()) {
      const lines=wrap(entry.label,columnWidth-keyWidth);
      cells.push({entry,lines,x:column*(columnWidth+gap),y,textWidth:columnWidth-keyWidth});
      tallest=Math.max(tallest,lines.length);
    }
    y+=tallest*lineHeight+rowGap;
  }
  return {cells,height:y,keyWidth};
}

function wrapLabel(ctx,label,width) {
  const lines=[];
  let line='';
  for(const word of label.split(/\s+/)){
    const next=line ? line+' '+word : word;
    if(line && ctx.measureText(next).width>width){lines.push(line);line=word;}
    else line=next;
  }
  if(line) lines.push(line);
  return lines;
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
        const map = await exportMapImage(view());
        const entries = mapLegend(legend);
        const width = Math.max(map.width+48,800);
        const measure = canvas(1,1).getContext('2d');
        measure.font='18px sans-serif';
        const layout = legendLayout(entries,width-48,18,42,22,7,(label,limit)=>wrapLabel(measure,label,limit));
        const output = canvas(width,map.height+126+layout.height);
        const ctx = output.getContext('2d');
        ctx.fillStyle='#fff'; ctx.fillRect(0,0,output.width,output.height);
        ctx.fillStyle='#183b35'; ctx.font='bold 28px sans-serif'; ctx.fillText(title,24,42,output.width-48);
        ctx.drawImage(map,(output.width-map.width)/2,65);
        ctx.strokeStyle='#aebfba';ctx.strokeRect((output.width-map.width)/2,65,map.width,map.height);
        ctx.font='18px sans-serif';
        for (const {entry,lines,x,y,textWidth} of layout.cells) {
          const left=24+x, top=map.height+86+y;
          paintLegendKey(ctx,entry.colors,entry.striped,left,top,32,14);
          ctx.fillStyle='#183b35';
          lines.forEach((line,index)=>ctx.fillText(line,left+layout.keyWidth,top+14+22*index,textWidth));
        }
        ctx.fillStyle='#355d53';ctx.font='15px sans-serif';
        ctx.fillText(map.basemapCredit,24,output.height-15,output.width-48);
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
