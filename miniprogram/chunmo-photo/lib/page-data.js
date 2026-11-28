function setChanged(page, next) {
  const patch = {};
  for (const key of Object.keys(next)) {
    if (JSON.stringify(page.data[key]) !== JSON.stringify(next[key])) patch[key] = next[key];
  }
  if (Object.keys(patch).length) page.setData(patch);
}
module.exports = { setChanged };
