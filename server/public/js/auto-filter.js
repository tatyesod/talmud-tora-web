// סינון אוטומטי: select → הגשה מיידית. text → debounce 900ms (מספיק להקלדת שם מלא)
document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll("form.auto-filter").forEach((form) => {
    form.querySelectorAll("select").forEach((el) => {
      el.addEventListener("change", () => form.submit());
    });
    let debounceTimer;
    form.querySelectorAll('input[type="text"]').forEach((el) => {
      el.addEventListener("input", () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => form.submit(), 900);
      });
    });
  });
});
