// Applies the saved theme before first paint (kept out of index.html so the CSP can forbid inline scripts).
try {
  const th = localStorage.getItem('cpm.theme');
  const dark = th === 'dark' || ((!th || th === 'system') && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
} catch { document.documentElement.dataset.theme = 'light'; }
