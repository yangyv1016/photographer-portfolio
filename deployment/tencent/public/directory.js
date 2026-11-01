const search = document.querySelector('.directory-search');
const query = document.querySelector('#directory-query');
function filterDirectory() {
  const value = query.value.trim().toLowerCase();
  let visible = 0;
  for (const card of document.querySelectorAll('.photographer-card')) {
    card.hidden = !card.dataset.search.includes(value);
    if (!card.hidden) visible++;
  }
  const empty = document.querySelector('#directory-empty');
  empty.hidden = visible > 0;
  empty.textContent = value ? '没有找到这位摄影师。' : '暂无摄影师。';
}
search.addEventListener('submit', event => { event.preventDefault(); filterDirectory(); });
query.addEventListener('input', filterDirectory);
