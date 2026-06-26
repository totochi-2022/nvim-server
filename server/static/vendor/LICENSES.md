# Third-Party Bundled Libraries

The files under `server/static/vendor/` are third-party libraries vendored for
offline use. They are **not** covered by this project's own license; each is
distributed under its own license (all MIT). The copyright notices below are
retained to satisfy those licenses.

| File(s) | Library | Version | Copyright | Source |
|---|---|---|---|---|
| `three.module.js`, `three-addons/**` | three.js (core + examples/jsm addons: `OrbitControls`, `STLLoader`) | 2010–2023 line | Copyright © 2010-2023 three.js authors | https://github.com/mrdoob/three.js |
| `chart.umd.min.js` | Chart.js | 4.4.1 | Copyright © 2023 Chart.js Contributors | https://github.com/chartjs/Chart.js |
| `dxf.mjs` | dxf | bundled via esbuild | Copyright © Ben Nortier | https://github.com/bjnortier/dxf |

> `three.module.js` keeps its `@license` banner and `chart.umd.min.js` keeps its
> MIT banner. `dxf.mjs` lost its banner during bundling, so its copyright /
> license is recorded here instead.

---

## MIT License (applies to each library above)

```
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
