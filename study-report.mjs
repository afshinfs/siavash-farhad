import { exportMapImage, exportLegend, mapLegend, paintLegendKey, legendLayout } from './map-export.mjs?v=legend-columns';

let pdfLibrary;
function loadPDF() {
  if (!pdfLibrary) pdfLibrary = new Promise((resolve,reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/jspdf@4.2.1/dist/jspdf.umd.min.js';
    script.onload = () => window.jspdf?.jsPDF ? resolve(window.jspdf.jsPDF) : reject(Error('PDF library did not initialize.'));
    script.onerror = () => {script.remove(); reject(Error('Could not load the PDF library. Check your connection and try again.'));};
    document.head.append(script);
  }).catch(error => {pdfLibrary=null;throw error;});
  return pdfLibrary;
}

// Ignore the hidden workflow tab itself, but skip cleared or inactive result panels.
function available(element, step) {
  for(let node=element;node && node!==step;node=node.parentElement) if(node.hidden) return false;
  return true;
}

function collect(groups) {
  return groups.flatMap(({number, title, sections}) => sections.flatMap(section =>
    [...section.querySelectorAll('study-area-map')].filter(view =>
      view.canvas?.width && available(view,section)
    ).map(view => ({
      section: number+' · '+title,
      group: section.querySelector('h2')?.textContent,
      title: view.canvas.getAttribute('aria-label'),
      image: bounds => exportMapImage(view,bounds),
      legend: () => exportLegend(view),
    }))
  ));
}

const clean = value => String(value ?? '').replaceAll('−','-').replaceAll('×','x').replaceAll(' ',' ');
function write(pdf,text,x,y,width,size=11,weight='normal') {
  pdf.setFont('helvetica',weight);
  pdf.setFontSize(size);
  const lines=pdf.splitTextToSize(clean(text),width);
  pdf.text(lines,x,y);
  return y+lines.length*size*.43;
}

function legendImage(entry) {
  const image=document.createElement('canvas');
  image.width=96;image.height=24;
  paintLegendKey(image.getContext('2d'),entry.colors,entry.striped,0,0,96,24);
  return image;
}

export function createStudyReport({groups, readBounds, getExtraOutputs}) {
  const fields = id => document.getElementById('study-report-'+id);
  const form=fields('form'), list=fields('outputs'), status=fields('status'), run=fields('run');
  let choices=[], busy=false;
  function refresh() {
    const old=new Map(choices.map(({key,input})=>[key,input.checked]));
    list.replaceChildren();
    const bounds=readBounds();
    fields('place').textContent=bounds
      ? 'Study area (WGS 84) · '+['west','south','east','north'].map(key=>key+' '+bounds[key].toFixed(6)+'°').join(' · ')
      : 'Select and apply a study area in Step 01 before exporting a report.';
    const outputs=bounds ? [...collect(groups), ...getExtraOutputs()].sort((a,b)=>a.section.localeCompare(b.section)) : [];
    choices=[];
    let lastSection, fieldset;
    for (const output of outputs) {
      if (lastSection!==output.section) {
        fieldset=document.createElement('fieldset');
        const legend=document.createElement('legend');legend.textContent=output.section;
        fieldset.append(legend);list.append(fieldset);lastSection=output.section;
      }
      const label=document.createElement('label'),input=document.createElement('input');
      input.type='checkbox';
      const title=[output.group,output.title].filter((value,i,all)=>value && all.indexOf(value)===i).join(' · ');
      const key=output.section+' '+title;
      input.checked=old.get(key) ?? false;
      choices.push({output,input,key});
      label.append(input,title);fieldset.append(label);
    }
    run.disabled=busy || !choices.some(choice=>choice.input.checked);
    fields('select').disabled=busy || !choices.length;
    fields('clear').disabled=fields('select').disabled;
    if(!busy) status.textContent=bounds && !choices.length ? 'Generate an output in the workflow to add it here.' : '';
  }
  const update = () => {run.disabled=busy || !choices.some(choice=>choice.input.checked);};
  list.onchange=update;
  for(const [name,checked] of [['select',true],['clear',false]]) fields(name).onclick=()=>{
    for(const {input} of choices) input.checked=checked;
    update();
  };
  form.onsubmit=async event=>{
    event.preventDefault();
    const bounds=readBounds();
    const selected=choices.filter(({input})=>input.checked);
    if (!bounds || !selected.length || busy || !form.reportValidity()) return;
    busy=true;update();
    const title=fields('title-input').value.trim() || 'Flood hazard and risk report';
    status.textContent='Preparing PDF…';
    try {
      const PDF=await loadPDF();
      const pdf=new PDF({format:'a4',compress:true});
      pdf.setProperties({title,creator:'SIAVASH & FARHAD WebGIS'});
      const extent=['west','south','east','north'].map(key=>key+' '+bounds[key].toFixed(6)).join('  |  ');
      const header = () => {
        pdf.setTextColor(23,60,52);
        let y=write(pdf,title,16,21,178,18,'bold');
        y=write(pdf,'SIAVASH & FARHAD WebGIS | Selected study area (WGS 84)',16,y+4,178,10);
        return write(pdf,extent,16,y+2,178,9)+7;
      };
      for (const [index,{output}] of selected.entries()) {
        if(index) pdf.addPage();
        let y=header();
        y=write(pdf,output.section,16,y,178,13,'bold')+3;
        const subtitle=[output.group,output.title].filter((v,i,a)=>v&&a.indexOf(v)===i).join(' / ');
        y=write(pdf,subtitle,16,y,178,11)+6;
        const image=await output.image(bounds);
        pdf.setFont('helvetica','normal');
        pdf.setFontSize(9);
        const layout=legendLayout(output.legend(),178,5,13,4,2,
          (label,limit)=>pdf.splitTextToSize(clean(label),limit));
        pdf.setFontSize(8);
        const creditLines=pdf.splitTextToSize(clean(image.basemapCredit),178).length;
        const legendStart=5+creditLines*8*.43+3;
        const mapHeight=Math.min(155,278-y-legendStart-layout.height);
        const ratio=Math.min(178/image.width,mapHeight/image.height);
        const width=image.width*ratio,height=image.height*ratio,x=(210-width)/2;
        pdf.addImage(image,'PNG',x,y,width,height);
        pdf.setDrawColor(175,192,184);pdf.rect(x,y,width,height);
        y=write(pdf,image.basemapCredit,16,y+height+5,178,8)+3;
        pdf.setFontSize(9);
        for (const {entry,lines,x:column,y:row} of layout.cells) {
          const left=16+column, baseline=y+row;
          if(entry.colors.length) pdf.addImage(legendImage(entry),'PNG',left,baseline-2.7,10,2.5);
          lines.forEach((line,index)=>pdf.text(line,left+layout.keyWidth,baseline+4*index));
        }
      }
      for(let page=1;page<=pdf.getNumberOfPages();page++){
        pdf.setPage(page);
        write(pdf,'Screening output | Maps clipped to the selected study area | '+page+' / '+pdf.getNumberOfPages(),16,287,178,9);
      }
      const current=readBounds();
      if (!current || Object.keys(bounds).some(key=>current[key]!==bounds[key])) {
        throw Error('The applied study area changed. Review the selected outputs and export again.');
      }
      pdf.save('siavash-farhad-study-area-report.pdf');
      status.textContent='PDF exported with '+selected.length+' selected output'+(selected.length===1?'':'s')+'.';
    } catch(error) {
      status.textContent=error.message;
    } finally {busy=false;update();}
  };
  return {refresh};
}

export function weaklineOutput(element) {
  if (!element.exportFeatures) return null;
  const options = {
    vectors: element.exportFeatures,
    vectorColor: feature=>({30:'#a52935',100:'#a65c00',300:'#166879',1000:'#61439a'})[feature.properties.firstScreenedPeriodYears] || '#112127',
  };
  return {section:'06 · Weakline scenarios',title:'Candidate weaklines',
    image: bounds=>exportMapImage(options,bounds),
    legend: ()=>mapLegend(element.nextElementSibling).filter(entry=>entry.label!=='Selected line')};
}

export function rasterPreviewOutput(section,title,read,unit) {
  let legend;
  return {section,title,
    async image(bounds) {
      const {grid,rgba,min,max}=await read();
      const source=document.createElement('canvas');
      Object.assign(source,grid.dimensions);
      source.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba),source.width,source.height),0,0);
      legend=[{label:unit+' · '+min.toPrecision(4)+' to '+max.toPrecision(4),colors:['#e0f0f9','#1d5e83']}];
      return exportMapImage({canvas:source,grid},bounds);
    },
    legend:()=>legend,
  };
}
