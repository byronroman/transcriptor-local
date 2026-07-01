import { register } from "../runtime.js";

function $(id) {
  return document.getElementById(id);
}

function on(id, eventName, handler) {
  const element = $(id);
  if (!element) {
    console.warn(`Elemento no encontrado: #${id}`);
    return;
  }
  element.addEventListener(eventName, handler);
}

register({ $, on });
