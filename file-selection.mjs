// Keep the browser's file name and the clear control in sync with the active override.
export function setFileClearButton(input, clear) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'secondary file-clear-button';
  button.textContent = 'Clear selected file';
  button.setAttribute('aria-label', 'Clear ' + input.closest('label').textContent.trim());
  input.closest('label').after(button);
  const refresh = () => { button.hidden = !input.files.length; };
  input.addEventListener('change', refresh);
  input.addEventListener('file-source-cleared', refresh);
  button.onclick = () => {
    input.value = '';
    clear();
    refresh();
  };
  refresh();
  return refresh;
}

export function reflectFileSource(input, source) {
  if (input.files[0] && input.files[0] !== source) {
    input.value = '';
    input.dispatchEvent(new Event('file-source-cleared'));
  }
}
