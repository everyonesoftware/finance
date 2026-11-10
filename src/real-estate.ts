import { escapeHtml } from "./html-utils.ts";

type Place = { display_name: string; lat: string; lon: string };
type Estimate = { amount: number; createdAt: number; provider?: "manual" | "zillow" | "redfin"; sourceNotes?: string | null };
type Property = { id:string; address:string; latitude:number; longitude:number; zillowUrl?:string|null; redfinUrl?:string|null; estimates:Estimate[] };

export function renderRealEstateCards(properties: Property[]): string {
  if (!properties.length) return `<div class="accounts-empty"><strong>No properties added yet</strong><span>Add a property to start tracking real-estate estimates.</span></div>`;
  return properties.map((property) => {
    const money=(value:number)=>new Intl.NumberFormat(undefined,{style:"currency",currency:"USD",maximumFractionDigits:0}).format(value);
    const map=`https://maps.google.com/maps?q=${encodeURIComponent(`${property.latitude},${property.longitude}`)}&z=15&output=embed`;
    const providerLabel=(provider:string)=>provider==="zillow"?"Zillow Zestimate":provider==="redfin"?"Redfin Estimate":"Manual estimate";
    const providers=["zillow","redfin","manual"] as const;
    const latest=providers.map(provider=>property.estimates.filter(e=>(e.provider??"manual")===provider).slice().sort((a,b)=>b.createdAt-a.createdAt)[0]).filter((e):e is Estimate=>!!e);
    const current=latest[0];
    const points=(provider:string)=>property.estimates.filter(e=>(e.provider??"manual")===provider).slice().sort((a,b)=>a.createdAt-b.createdAt);
    const allPoints=property.estimates.slice().sort((a,b)=>a.createdAt-b.createdAt);
    const maximum=Math.max(0,...allPoints.map(e=>e.amount));
    const yMax=Number((maximum*1.1).toFixed(2));
    const yScale=yMax||1;
    const minTime=allPoints[0]?.createdAt??0;
    const maxTime=allPoints[allPoints.length-1]?.createdAt??minTime;
    const chartLeft=58, chartRight=390, chartTop=14, chartBottom=190;
    const xFor=(date:number)=>chartLeft+(maxTime===minTime?0.5:(date-minTime)/(maxTime-minTime))*(chartRight-chartLeft);
    const yFor=(amount:number)=>chartBottom-(amount/yScale)*(chartBottom-chartTop);
    const yTicks=[0,0.25,0.5,0.75,1].map(ratio=>yMax*ratio);
    const yAxis=yTicks.map(value=>{const y=yFor(value);return `<line class="estimate-chart-grid" x1="${chartLeft}" y1="${y}" x2="${chartRight}" y2="${y}"/><text class="estimate-chart-label" x="${chartLeft-8}" y="${y+4}" text-anchor="end">${money(value)}</text>`;}).join("");
    const dateTicks=allPoints.filter((_,index)=>index===0||index===allPoints.length-1||allPoints.length<=5).map(point=>{const date=new Date(point.createdAt).toISOString().slice(0,10);return `<text class="estimate-chart-label" x="${xFor(point.createdAt)}" y="${chartBottom+22}" text-anchor="middle">${date}</text>`;}).join("");
    const chartSeries=providers.map(provider=>{const values=points(provider);if(!values.length)return "";const coords=values.map(e=>`${xFor(e.createdAt)},${yFor(e.amount)}`).join(" ");const markers=provider==="zillow"?values.map(e=>{const date=new Date(e.createdAt).toISOString().slice(0,10);return `<circle class="estimate-point-zillow" cx="${xFor(e.createdAt)}" cy="${yFor(e.amount)}" r="4" tabindex="0" aria-label="${date}: ${money(e.amount)}" data-estimate-date="${date}" data-estimate-value="${escapeHtml(money(e.amount))}"/>`;}).join(""):"";return `<polyline class="estimate-series-${provider}" points="${coords}"/>${markers}`;}).join("");
    const chart=`<div class="estimate-chart-wrap" data-tooltip-delay="300"><svg class="estimate-history-chart" viewBox="0 0 410 230" role="img" aria-label="Estimate history by source, values from zero to ${money(yMax)}" data-y-min="0" data-y-max="${yMax}">${yAxis}<line class="estimate-chart-axis" x1="${chartLeft}" y1="${chartTop}" x2="${chartLeft}" y2="${chartBottom}"/><line class="estimate-chart-axis" x1="${chartLeft}" y1="${chartBottom}" x2="${chartRight}" y2="${chartBottom}"/>${chartSeries}${dateTicks}</svg><div class="estimate-chart-tooltip" role="tooltip" aria-hidden="true" hidden><span class="estimate-chart-tooltip-date"></span><strong class="estimate-chart-tooltip-value"></strong></div></div>`;
    return `<details class="connection-card real-estate-card"><summary class="connection-heading"><span class="connected-account-icon" aria-hidden="true">⌂</span><span class="connection-title"><span class="eyebrow">REAL ESTATE</span><strong>${escapeHtml(property.address)}</strong></span></summary><details class="connection-actions-menu"><summary class="connection-menu-trigger" aria-label="More actions for ${escapeHtml(property.address)}" title="More actions for ${escapeHtml(property.address)}"><span aria-hidden="true">⋯</span></summary><div class="connection-menu-popup"><button type="button" class="delete-connection-button" data-connection-type="real-estate" data-connection-id="${escapeHtml(property.id)}" data-connection-name="${escapeHtml(property.address)}">Delete</button></div></details><div class="real-estate-details"><section class="estimate-panel"><div class="current-estimate-row"><strong>Estimate:</strong><span class="current-estimate-value">${current?money(current.amount):"Not provided"}</span></div><div class="provider-estimates">${latest.map(e=>`<div class="provider-estimate"><span class="estimate-source">${providerLabel(e.provider??"manual")}</span><span>${money(e.amount)}</span>${e.provider==="zillow"?`<a class="estimate-source-link" href="${escapeHtml(property.zillowUrl||"https://www.zillow.com/")}" target="_blank" rel="noopener noreferrer">Visit Zillow</a>`:e.provider==="redfin"?`<a class="estimate-source-link" href="${escapeHtml(property.redfinUrl||"https://www.redfin.com/")}" target="_blank" rel="noopener noreferrer">Visit Redfin</a>`:""}</div>`).join("")}</div><button type="button" class="manual-estimate-add">+ Add manual estimate</button><form class="manual-estimate-form" data-property-id="${escapeHtml(property.id)}" hidden><label>Amount<input name="amount" type="number" min="0" step="0.01" required></label><label>Comment<input name="sourceNotes" maxlength="2000" type="text" placeholder="Optional comment"></label><div><button type="submit">Save estimate</button><button type="button" class="manual-estimate-cancel">Cancel</button></div><span class="manual-estimate-error" role="alert"></span></form><h3>Estimate history</h3>${chart}</section><iframe class="property-map-frame" title="Map showing ${escapeHtml(property.address)}" loading="lazy" src="${map}"></iframe></div></details>`;
  }).join("");
}


let realEstateInitialized = false;

export function initializeRealEstateConnections(onSaved: () => void): void {
  if (realEstateInitialized) return;
  realEstateInitialized = true;
  const dialog=document.querySelector<HTMLDialogElement>("#connection-dialog");
  const connectionDialogTitle=document.querySelector<HTMLElement>("#connection-dialog-title");
  const estimateSourcesHeading=document.querySelector<HTMLElement>("#estimate-sources-heading");
  const choices=document.querySelector<HTMLElement>("#connection-choices");
  const wizard=document.querySelector<HTMLElement>("#real-estate-wizard");
  const addressInput=document.querySelector<HTMLInputElement>("#property-address");
  const suggestions=document.querySelector<HTMLElement>("#address-suggestions");
  const map=document.querySelector<HTMLElement>("#property-map-preview");
  const next=document.querySelector<HTMLButtonElement>("#real-estate-next");
  const back=document.querySelector<HTMLButtonElement>("#real-estate-back");
  const stepAddress=document.querySelector<HTMLElement>("#real-estate-step-address");
  const stepProvider=document.querySelector<HTMLElement>("#real-estate-step-provider");
  const zillowUrlInput=document.querySelector<HTMLInputElement>("#zillow-property-url");
  const redfinUrlInput=document.querySelector<HTMLInputElement>("#redfin-property-url");
  const estimateInput=document.querySelector<HTMLInputElement>("#manual-estimate");
  const manualNotes=document.querySelector<HTMLInputElement>("#manual-source-notes");
  let selected:Place|null=null; let timer=0;
  const resetAddressStep=()=>{if(stepAddress)stepAddress.hidden=false;if(stepProvider)stepProvider.hidden=true;if(estimateSourcesHeading)estimateSourcesHeading.hidden=true;if(next){next.textContent="Next";next.disabled=!selected;}};
  const saveRealEstate=async()=>{
    const amount=Number(estimateInput?.value);const manualValue=estimateInput?.value.trim()??"";const zillowUrl=zillowUrlInput?.value.trim()??"";const redfinUrl=redfinUrlInput?.value.trim()??"";const message=document.querySelector<HTMLElement>("#connection-dialog-message");
    const hasSource=manualValue!==""||!!zillowUrl||!!redfinUrl;
    if(!selected||(manualValue!==""&&(!Number.isFinite(amount)||amount<0))||!hasSource){if(message)message.textContent="Choose at least one source and provide valid values.";return;}
    if(next)next.disabled=true;
    const payload:Record<string,unknown>={address:selected.display_name,latitude:Number(selected.lat),longitude:Number(selected.lon)};
    if(estimateInput?.value.trim())payload.amount=amount;if(manualNotes?.value.trim())payload.sourceNotes=manualNotes.value.trim();if(zillowUrl)payload.zillowUrl=zillowUrl;if(redfinUrl)payload.redfinUrl=redfinUrl;
    try { const response=await fetch("/api/real-estate",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});const result=await response.json() as {error?:string};if(!response.ok)throw new Error(result.error??"Unable to save property.");dialog?.close();onSaved(); }
    catch(error){if(message)message.textContent=error instanceof Error?error.message:"Unable to save property.";}
    finally {if(next)next.disabled=false;}
  };
  document.querySelector("#add-connection")?.addEventListener("click",()=>{
    if(connectionDialogTitle)connectionDialogTitle.textContent="Add Connection";
    if(dialog)dialog.dataset.step="choices";
    if(choices)choices.hidden=false;if(wizard)wizard.hidden=true;resetAddressStep();
    if(addressInput)addressInput.value="";if(estimateInput)estimateInput.value="";if(zillowUrlInput)zillowUrlInput.value="";if(redfinUrlInput)redfinUrlInput.value="";if(suggestions)suggestions.replaceChildren();if(map)map.replaceChildren();selected=null;if(next)next.disabled=true;
    dialog?.showModal();
  });
  document.querySelector("#close-connection-dialog")?.addEventListener("click",()=>dialog?.close());
  document.querySelector("#choose-teller")?.addEventListener("click",()=>{dialog?.close(); location.href="/accounts?connect=teller";});
  document.querySelector("#choose-real-estate")?.addEventListener("click",()=>{if(choices)choices.hidden=true;if(wizard)wizard.hidden=false;if(connectionDialogTitle)connectionDialogTitle.textContent="Add Real Estate";if(dialog)dialog.dataset.step="address";});
  back?.addEventListener("click",()=>{
    if(stepProvider&&!stepProvider.hidden){resetAddressStep();if(dialog)dialog.dataset.step="address";return;}
    if(wizard)wizard.hidden=true;if(choices)choices.hidden=false;if(connectionDialogTitle)connectionDialogTitle.textContent="Add Connection";if(estimateSourcesHeading)estimateSourcesHeading.hidden=true;if(dialog)dialog.dataset.step="choices";
  });
  addressInput?.addEventListener("input",()=>{
    selected=null;if(next)next.disabled=true;if(map)map.innerHTML=""; if(suggestions)suggestions.replaceChildren();
    const query=addressInput.value.trim(); if(query.length<4)return;
    window.clearTimeout(timer); timer=window.setTimeout(async()=>{
      try { const response=await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=5&q=${encodeURIComponent(query)}`,{headers:{Accept:"application/json"}}); if(!response.ok)return;
        const places=await response.json() as Place[]; if(!suggestions)return;
        suggestions.innerHTML=places.map((place,index)=>`<button type="button" role="option" data-place-index="${index}">${escapeHtml(place.display_name)}</button>`).join("");
        suggestions.querySelectorAll<HTMLButtonElement>("button").forEach((button)=>button.addEventListener("click",()=>{
          const place=places[Number(button.dataset.placeIndex)]; if(!place)return;selected=place;addressInput.value=place.display_name;suggestions.replaceChildren();if(next)next.disabled=false;
          if(map)map.innerHTML=`<iframe title="Selected property map" loading="lazy" src="https://maps.google.com/maps?q=${encodeURIComponent(`${place.lat},${place.lon}`)}&z=15&output=embed"></iframe>`;
        }));
      } catch { if(suggestions)suggestions.textContent="Address suggestions are unavailable. You can try again."; }
    },350);
  });
  next?.addEventListener("click",()=>{
    if(stepAddress&&!stepAddress.hidden){if(!selected)return;if(stepAddress)stepAddress.hidden=true;if(stepProvider)stepProvider.hidden=false;if(estimateSourcesHeading)estimateSourcesHeading.hidden=false;if(dialog)dialog.dataset.step="provider";next.textContent="Done";next.disabled=false;return;}
    void saveRealEstate();
  });
  const updateProviderSelections=()=>{if(next){const amount=estimateInput?.value.trim()??"";const zillow=zillowUrlInput?.value.trim()??"";const redfin=redfinUrlInput?.value.trim()??"";next.textContent="Done";next.disabled=(!amount&&!zillow&&!redfin)||(!!amount&&(!Number.isFinite(Number(amount))||Number(amount)<0));}};
  zillowUrlInput?.addEventListener("input",updateProviderSelections);redfinUrlInput?.addEventListener("input",updateProviderSelections);estimateInput?.addEventListener("input",updateProviderSelections);


  const integrations=document.querySelector<HTMLElement>("#connected-integrations");
  let chartTooltipTimer=0;
  const hideChartTooltip=()=>{window.clearTimeout(chartTooltipTimer);integrations?.querySelectorAll<HTMLElement>(".estimate-chart-tooltip").forEach((tooltip)=>{tooltip.hidden=true;tooltip.setAttribute("aria-hidden","true");});};
  const showChartTooltip=(marker:SVGCircleElement, delay?:number)=>{
    hideChartTooltip();
    const wrapper=marker.closest<HTMLElement>(".estimate-chart-wrap");
    const tooltip=wrapper?.querySelector<HTMLElement>(".estimate-chart-tooltip");
    if(!wrapper||!tooltip)return;
    const reveal=()=>{
      const date=tooltip.querySelector<HTMLElement>(".estimate-chart-tooltip-date");
      const value=tooltip.querySelector<HTMLElement>(".estimate-chart-tooltip-value");
      if(date)date.textContent=marker.dataset.estimateDate??"";
      if(value)value.textContent=marker.dataset.estimateValue??"";
      const markerRect=marker.getBoundingClientRect();
      const wrapperRect=wrapper.getBoundingClientRect();
      const halfWidth=tooltip.offsetWidth/2;
      const left=Math.max(halfWidth+4,Math.min(markerRect.left-wrapperRect.left+markerRect.width/2,wrapperRect.width-halfWidth-4));
      tooltip.style.left=`${left}px`;
      tooltip.style.top=`${Math.max(4,markerRect.top-wrapperRect.top-8)}px`;
      tooltip.hidden=false;
      tooltip.setAttribute("aria-hidden","false");
    };
    const tooltipDelay=delay??(Number(wrapper.dataset.tooltipDelay)||300);
    if(tooltipDelay===0)reveal();
    else chartTooltipTimer=window.setTimeout(reveal,tooltipDelay);
  };
  integrations?.addEventListener("pointerover",(event)=>{
    const target=event.target;if(!(target instanceof Element))return;
    const marker=target.closest<SVGCircleElement>(".estimate-point-zillow");
    if(marker&&!marker.contains(event.relatedTarget as Node|null))showChartTooltip(marker);
  });
  integrations?.addEventListener("pointerout",(event)=>{
    const target=event.target;if(!(target instanceof Element))return;
    const marker=target.closest<SVGCircleElement>(".estimate-point-zillow");
    if(marker&&!marker.contains(event.relatedTarget as Node|null))hideChartTooltip();
  });
  integrations?.addEventListener("focusin",(event)=>{
    const target=event.target;if(target instanceof Element){const marker=target.closest<SVGCircleElement>(".estimate-point-zillow");if(marker)showChartTooltip(marker,0);}
  });
  integrations?.addEventListener("focusout",(event)=>{
    const target=event.target;if(target instanceof Element&&target.closest(".estimate-point-zillow"))hideChartTooltip();
  });
  integrations?.addEventListener("click",(event)=>{
    const target=event.target;if(!(target instanceof Element))return;
    const chartPoint=target.closest<SVGCircleElement>(".estimate-point-zillow");
    if(chartPoint){chartPoint.focus({preventScroll:true});return;}
    const manualAdd=target.closest<HTMLButtonElement>(".manual-estimate-add");
    if(manualAdd){const panel=manualAdd.closest<HTMLElement>(".estimate-panel");const form=panel?.querySelector<HTMLFormElement>(".manual-estimate-form");manualAdd.hidden=true;if(form){form.hidden=false;form.querySelector<HTMLInputElement>("[name=amount]")?.focus();}return;}
    const manualCancel=target.closest<HTMLButtonElement>(".manual-estimate-cancel");
    if(manualCancel){const form=manualCancel.closest<HTMLFormElement>(".manual-estimate-form");if(form){form.reset();form.hidden=true;const add=form.closest<HTMLElement>(".estimate-panel")?.querySelector<HTMLButtonElement>(".manual-estimate-add");if(add)add.hidden=false;}return;}
    const refreshButton=target.closest<HTMLButtonElement>(".zillow-refresh-button");
    if(refreshButton){const details=refreshButton.closest<HTMLElement>(".real-estate-details");const refreshForm=details?.querySelector<HTMLFormElement>(".zillow-refresh-form");refreshButton.hidden=true;if(refreshForm){refreshForm.hidden=false;refreshForm.querySelector<HTMLInputElement>("[name=zillowUrl]")?.focus();}return;}
    const editButton=target.closest<HTMLButtonElement>(".estimate-edit-button");if(!editButton)return;
    const details=editButton.closest<HTMLElement>(".real-estate-details");const value=details?.querySelector<HTMLElement>(".current-estimate-value");const form=details?.querySelector<HTMLFormElement>(".estimate-edit-form");
    if(value)value.hidden=true;editButton.hidden=true;if(form){form.hidden=false;form.querySelector<HTMLInputElement>("[name=amount]")?.focus();}
  });
  integrations?.addEventListener("submit",async(event)=>{
    const form=event.target;if(!(form instanceof HTMLFormElement))return;
    if(form.matches(".manual-estimate-form")){event.preventDefault();const amountInput=form.querySelector<HTMLInputElement>("[name=amount]");const notes=form.querySelector<HTMLInputElement>("[name=sourceNotes]");const amount=Number(amountInput?.value);if(!amountInput?.value.trim()||!Number.isFinite(amount)||amount<0)return;const button=form.querySelector<HTMLButtonElement>("button[type=submit]");if(button)button.disabled=true;try{const response=await fetch(`/api/real-estate/${encodeURIComponent(form.dataset.propertyId??"")}/estimates`,{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({amount,sourceNotes:notes?.value.trim()??""})});const payload=await response.json() as {error?:string};if(!response.ok)throw new Error(payload.error??"Unable to save estimate.");onSaved();}catch(error){const errorNode=form.querySelector<HTMLElement>(".manual-estimate-error");if(errorNode)errorNode.textContent=error instanceof Error?error.message:"Unable to save estimate.";if(button)button.disabled=false;}return;}
    if(form.matches(".zillow-refresh-form")){
      event.preventDefault();const input=form.querySelector<HTMLInputElement>("[name=zillowUrl]");const zillowUrl=input?.value.trim();if(!zillowUrl)return;
      const button=form.querySelector<HTMLButtonElement>("button[type=submit]");if(button)button.disabled=true;
      try{const response=await fetch(`/api/real-estate/${encodeURIComponent(form.dataset.propertyId??"")}/zillow`,{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({zillowUrl})});const payload=await response.json() as {error?:string};if(!response.ok)throw new Error(payload.error??"Unable to retrieve Zillow estimate.");onSaved();}
      catch(error){const errorNode=form.querySelector<HTMLElement>(".zillow-refresh-error");if(errorNode)errorNode.textContent=error instanceof Error?error.message:"Unable to retrieve Zillow estimate.";if(button)button.disabled=false;}
      return;
    }
    if(!form.matches(".estimate-edit-form"))return;event.preventDefault();
    const input=form.querySelector<HTMLInputElement>("[name=amount]");const amount=Number(input?.value);if(!input?.value.trim()||!Number.isFinite(amount)||amount<0)return;
    const button=form.querySelector<HTMLButtonElement>("button[type=submit]");if(button)button.disabled=true;
    try {
      const response=await fetch(`/api/real-estate/${encodeURIComponent(form.dataset.propertyId??"")}/estimates`,{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({amount})});
      if(!response.ok){const payload=await response.json() as {error?:string};throw new Error(payload.error??"Unable to save estimate.");}
      onSaved();
    } catch(error) { const errorNode=form.querySelector<HTMLElement>(".estimate-edit-error");if(errorNode)errorNode.textContent=error instanceof Error?error.message:"Unable to save estimate.";if(button)button.disabled=false; }
  });
}
