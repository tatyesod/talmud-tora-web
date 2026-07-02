// כפתור גלילה מהירה למעלה
(function() {
  const btn = document.createElement('button');
  btn.id = 'scroll-to-top';
  btn.title = 'חזרה למעלה';
  btn.innerHTML = '↑';
  document.body.appendChild(btn);

  window.addEventListener('scroll', () => {
    btn.classList.toggle('visible', window.scrollY > 300);
  }, { passive: true });

  btn.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
})();
