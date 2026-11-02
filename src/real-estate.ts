import { escapeHtml } from "./html-utils.ts";

type Place = { display_name: string; lat: string; lon: string };
type Estimate = { amount: number; createdAt: number };
type Property = { id:string; address:string; latitude:number; longitude:number; estimates:Estimate[] };

export function renderRealEstateCards(properties: Property[]): string {
  if (!properties.length) return `<div class="accounts-empty"><strong>No connections yet</strong><span>Add a bank or real-estate property to get started.</span></div>`;
  return properties.map((property) => {
    const latest = property.estimates[0];
    const money=(value:number)=>new Intl.NumberFormat(undefined,{style:"currency",currency:"USD",maximumFractionDigits:0}).format(value);
    const history = property.estimates.map((estimate) => `<li>${new Intl.DateTimeFormat(undefined,{dateStyle:"medium"}).format(new Date(estimate.createdAt))}: ${money(estimate.amount)}</li>`).join("");
    const map=`https://maps.google.com/maps?q=${encodeURIComponent(`${property.latitude},${property.longitude}`)}&z=15&output=embed`;
    return `<details class="connection-card real-estate-card"><summary class="connection-heading"><span class="connected-account-icon" aria-hidden="true">⌂</span><span class="connection-title"><span class="eyebrow">REAL ESTATE</span><strong>${escapeHtml(property.address)}</strong><span>${latest ? `Manual estimate · ${money(latest.amount)}` : "No estimate yet"}</span></span><span class="connection-chevron" aria-hidden="true">⌄</span></summary><div class="real-estate-details"><p><strong>Current estimate:</strong> ${latest ? money(latest.amount) : "Not provided"}</p><iframe title="Map showing ${escapeHtml(property.address)}" loading="lazy" src="${map}"></iframe><h3>Manual estimate history</h3><ol>${history}</ol><form class="update-estimate" data-property-id="${escapeHtml(property.id)}"><label>Record a new estimate <input name="amount" type="number" min="0" step="0.01" required></label><button type="submit" class="secondary-button">Save estimate</button></form></div></details>`;
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
  let selected:Place|null=null; let timer=0;
  document.querySelector("#add-connection")?.addEventListener("click",()=>{
    const first=document.querySelector<HTMLElement>("#real-estate-step-address");const provider=document.querySelector<HTMLElement>("#real-estate-step-provider");const manual=document.querySelector<HTMLElement>("#manual-estimate-step");
    if(choices)choices.hidden=false;if(wizard)wizard.hidden=true;if(first)first.hidden=false;if(provider)provider.hidden=true;if(manual)manual.hidden=true;
    if(addressInput)addressInput.value="";if(suggestions)suggestions.replaceChildren();if(map)map.replaceChildren();selected=null;if(next)next.disabled=true;
    dialog?.showModal();
  });
  document.querySelector("#close-connection-dialog")?.addEventListener("click",()=>dialog?.close());
  document.querySelector("#choose-plaid")?.addEventListener("click",()=>{dialog?.close(); location.href="/accounts?connect=plaid";});
  document.querySelector("#choose-real-estate")?.addEventListener("click",()=>{if(choices)choices.hidden=true;if(wizard)wizard.hidden=false;});
  document.querySelector("#real-estate-choice-back")?.addEventListener("click",()=>{if(wizard)wizard.hidden=true;if(choices)choices.hidden=false;});
  document.querySelector("#real-estate-back")?.addEventListener("click",()=>{const step=document.querySelector<HTMLElement>("#real-estate-step-provider");if(step)step.hidden=true;const first=document.querySelector<HTMLElement>("#real-estate-step-address");if(first)first.hidden=false;});
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
  next?.addEventListener("click",()=>{if(!selected)return;const first=document.querySelector<HTMLElement>("#real-estate-step-address");const step=document.querySelector<HTMLElement>("#real-estate-step-provider");if(first)first.hidden=true;if(step)step.hidden=false;});
  document.querySelector("#choose-manual")?.addEventListener("click",()=>{const manual=document.querySelector<HTMLElement>("#manual-estimate-step");if(manual)manual.hidden=false;});
  document.querySelector("#save-real-estate")?.addEventListener("click",async()=>{
    const amountInput=document.querySelector<HTMLInputElement>("#manual-estimate");const amount=Number(amountInput?.value);
    const message=document.querySelector<HTMLElement>("#connection-dialog-message");
    if(!selected||!amountInput?.value.trim()||!Number.isFinite(amount)||amount<0){if(message)message.textContent="Select an address and enter a valid estimate.";return;}
    const button=document.querySelector<HTMLButtonElement>("#save-real-estate"); if(button)button.disabled=true;
    try { const response=await fetch("/api/real-estate",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({address:selected.display_name,latitude:Number(selected.lat),longitude:Number(selected.lon),amount})});const payload=await response.json() as {error?:string};if(!response.ok)throw new Error(payload.error??"Unable to save property.");dialog?.close();onSaved(); }
    catch(error){if(message)message.textContent=error instanceof Error?error.message:"Unable to save property.";}
    finally {if(button)button.disabled=false;}
  });
  document.querySelector("#connected-integrations")?.addEventListener("submit",async(event)=>{
    const form=event.target;if(!(form instanceof HTMLFormElement)||!form.matches(".update-estimate"))return;event.preventDefault();
    const amount=Number(new FormData(form).get("amount"));if(!Number.isFinite(amount)||amount<0)return;
    const response=await fetch(`/api/real-estate/${encodeURIComponent(form.dataset.propertyId??"")}/estimates`,{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({amount})});if(response.ok)onSaved();
  });
}
