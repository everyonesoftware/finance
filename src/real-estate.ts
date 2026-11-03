import { escapeHtml } from "./html-utils.ts";

type Place = { display_name: string; lat: string; lon: string };
type Estimate = { amount: number; createdAt: number; provider?: "manual" | "zillow" };
type Property = { id:string; address:string; latitude:number; longitude:number; estimates:Estimate[] };

export function renderRealEstateCards(properties: Property[]): string {
  if (!properties.length) return `<div class="accounts-empty"><strong>No connections yet</strong><span>Add a bank or real-estate property to get started.</span></div>`;
  return properties.map((property) => {
    const latest = property.estimates[0];
    const money=(value:number)=>new Intl.NumberFormat(undefined,{style:"currency",currency:"USD",maximumFractionDigits:0}).format(value);
    const map=`https://maps.google.com/maps?q=${encodeURIComponent(`${property.latitude},${property.longitude}`)}&z=15&output=embed`;
    return `<details class="connection-card real-estate-card"><summary class="connection-heading"><span class="connected-account-icon" aria-hidden="true">⌂</span><span class="connection-title"><span class="eyebrow">REAL ESTATE</span><strong>${escapeHtml(property.address)}</strong></span></summary><details class="connection-actions-menu"><summary class="connection-menu-trigger" aria-label="More actions for ${escapeHtml(property.address)}" title="More actions for ${escapeHtml(property.address)}"><span aria-hidden="true">⋯</span></summary><div class="connection-menu-popup"><button type="button" class="delete-connection-button" data-connection-type="real-estate" data-connection-id="${escapeHtml(property.id)}" data-connection-name="${escapeHtml(property.address)}">Delete</button></div></details><div class="real-estate-details"><div class="current-estimate-row"><strong>Estimate:</strong><span class="current-estimate-value">${latest ? money(latest.amount) : "Not provided"}</span><span class="estimate-source">${latest?.provider === "zillow" ? "Zillow Zestimate" : latest ? "Manual estimate" : ""}</span><button class="estimate-edit-button" type="button" aria-label="Edit estimate" title="Edit estimate" data-current-value="${latest?.amount ?? ""}">✎</button><button class="zillow-refresh-button" type="button" aria-label="Get Zillow Zestimate" title="Get Zillow Zestimate">Zillow</button><form class="zillow-refresh-form" data-property-id="${escapeHtml(property.id)}" hidden><label>Zillow page URL<input name="zillowUrl" type="url" required placeholder="https://www.zillow.com/homedetails/…"></label><button type="submit" class="zillow-refresh-submit">Get Zestimate</button><span class="zillow-refresh-error" role="alert"></span></form><form class="estimate-edit-form" data-property-id="${escapeHtml(property.id)}" hidden><input name="amount" type="number" min="0" step="0.01" required aria-label="Updated estimated value" value="${latest?.amount ?? ""}"><button type="submit" class="estimate-confirm-button" aria-label="Confirm estimate" title="Confirm estimate">☑</button><span class="estimate-edit-error" role="alert"></span></form></div><iframe class="property-map-frame" title="Map showing ${escapeHtml(property.address)}" loading="lazy" src="${map}"></iframe></div></details>`;
  }).join("");
}

let realEstateInitialized = false;

export function initializeRealEstateConnections(onSaved: () => void): void {
  if (realEstateInitialized) return;
  realEstateInitialized = true;
  const dialog=document.querySelector<HTMLDialogElement>("#connection-dialog");
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
  const manualNotes=document.querySelector<HTMLTextAreaElement>("#manual-source-notes");
  let selected:Place|null=null; let timer=0;
  const resetAddressStep=()=>{if(stepAddress)stepAddress.hidden=false;if(stepProvider)stepProvider.hidden=true;if(next){next.textContent="Next";next.disabled=!selected;}};
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
    if(dialog)dialog.dataset.step="choices";
    if(choices)choices.hidden=false;if(wizard)wizard.hidden=true;resetAddressStep();
    if(addressInput)addressInput.value="";if(estimateInput)estimateInput.value="";if(zillowUrlInput)zillowUrlInput.value="";if(redfinUrlInput)redfinUrlInput.value="";if(suggestions)suggestions.replaceChildren();if(map)map.replaceChildren();selected=null;if(next)next.disabled=true;
    dialog?.showModal();
  });
  document.querySelector("#close-connection-dialog")?.addEventListener("click",()=>dialog?.close());
  document.querySelector("#choose-plaid")?.addEventListener("click",()=>{dialog?.close(); location.href="/accounts?connect=plaid";});
  document.querySelector("#choose-real-estate")?.addEventListener("click",()=>{if(choices)choices.hidden=true;if(wizard)wizard.hidden=false;if(dialog)dialog.dataset.step="address";});
  back?.addEventListener("click",()=>{
    if(stepProvider&&!stepProvider.hidden){resetAddressStep();if(dialog)dialog.dataset.step="address";return;}
    if(wizard)wizard.hidden=true;if(choices)choices.hidden=false;if(dialog)dialog.dataset.step="choices";
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
    if(stepAddress&&!stepAddress.hidden){if(!selected)return;if(stepAddress)stepAddress.hidden=true;if(stepProvider)stepProvider.hidden=false;if(dialog)dialog.dataset.step="provider";next.textContent="Done";next.disabled=false;return;}
    void saveRealEstate();
  });
  const updateProviderSelections=()=>{if(next){const amount=estimateInput?.value.trim()??"";const zillow=zillowUrlInput?.value.trim()??"";const redfin=redfinUrlInput?.value.trim()??"";next.textContent="Done";next.disabled=(!amount&&!zillow&&!redfin)||(!!amount&&(!Number.isFinite(Number(amount))||Number(amount)<0));}};
  zillowUrlInput?.addEventListener("input",updateProviderSelections);redfinUrlInput?.addEventListener("input",updateProviderSelections);estimateInput?.addEventListener("input",updateProviderSelections);


  const integrations=document.querySelector<HTMLElement>("#connected-integrations");
  integrations?.addEventListener("click",(event)=>{
    const target=event.target;if(!(target instanceof Element))return;
    const refreshButton=target.closest<HTMLButtonElement>(".zillow-refresh-button");
    if(refreshButton){const details=refreshButton.closest<HTMLElement>(".real-estate-details");const refreshForm=details?.querySelector<HTMLFormElement>(".zillow-refresh-form");refreshButton.hidden=true;if(refreshForm){refreshForm.hidden=false;refreshForm.querySelector<HTMLInputElement>("[name=zillowUrl]")?.focus();}return;}
    const editButton=target.closest<HTMLButtonElement>(".estimate-edit-button");if(!editButton)return;
    const details=editButton.closest<HTMLElement>(".real-estate-details");const value=details?.querySelector<HTMLElement>(".current-estimate-value");const form=details?.querySelector<HTMLFormElement>(".estimate-edit-form");
    if(value)value.hidden=true;editButton.hidden=true;if(form){form.hidden=false;form.querySelector<HTMLInputElement>("[name=amount]")?.focus();}
  });
  integrations?.addEventListener("submit",async(event)=>{
    const form=event.target;if(!(form instanceof HTMLFormElement))return;
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
