# Native drawing fonts

Once drawings are wired into the build (roadmap phase 2 step 3), the app
ships the WOFF2 font files that come with `@excalidraw/excalidraw@0.18.1`,
unchanged, so native drawing font choices work without a network. It does not
fetch new font versions at runtime, change outlines, strip embedded
attribution or claim the font authors endorse this app.

The pinned package has 234 WOFF2 files in nine family directories. Most files
are the package's existing Unicode subsets, not new font families. Font faces
remain subject to their own licenses, not the application's license.

| Family directory | License | Local text | Attribution source |
| --- | --- | --- | --- |
| Assistant | SIL OFL 1.1 | [Bundled notice](native-Assistant-LICENSE.txt) | [Upstream source](https://raw.githubusercontent.com/google/fonts/main/ofl/assistant/OFL.txt) |
| Cascadia | SIL OFL 1.1 | [Bundled notice](native-Cascadia-LICENSE.txt) | [Upstream source](https://raw.githubusercontent.com/microsoft/cascadia-code/main/LICENSE) |
| Nunito | SIL OFL 1.1 | [Bundled notice](native-Nunito-LICENSE.txt) | [Upstream source](https://raw.githubusercontent.com/google/fonts/main/ofl/nunito/OFL.txt) |
| Lilita | SIL OFL 1.1 | [Bundled notice](native-Lilita-LICENSE.txt) | [Upstream source](https://raw.githubusercontent.com/google/fonts/main/ofl/lilitaone/OFL.txt) |
| Virgil | SIL OFL 1.1 | [Bundled notice](native-Virgil-LICENSE.txt) | [Upstream source](https://raw.githubusercontent.com/excalidraw/virgil/main/LICENSE.md) |
| Xiaolai | SIL OFL 1.1 | [Bundled notice](native-Xiaolai-LICENSE.txt) | [Upstream source](https://raw.githubusercontent.com/lxgw/kose-font/master/OFL.txt) |
| Excalifont | SIL OFL 1.1 | [Bundled notice](native-Excalifont-LICENSE.txt) | [Upstream source](https://raw.githubusercontent.com/excalidraw/excalidraw/v0.18.1/packages/excalidraw/fonts/Excalifont/index.ts) |
| ComicShanns | MIT | [Bundled notice](native-ComicShanns-LICENSE.txt) | [Upstream source](https://raw.githubusercontent.com/excalidraw/excalidraw/v0.18.1/packages/excalidraw/fonts/ComicShanns/index.ts) |
| Liberation | GPL v2 with font exception | [Bundled notice](native-Liberation-LICENSE.txt), [GPL v2](GPL-2.0.txt) | [Font source (1.05)](https://releases.pagure.org/liberation-fonts/liberation-fonts-1.05.tar.gz), [legacy repository](https://github.com/liberationfonts/liberation-1.7-fonts), [Excalidraw registration](https://github.com/excalidraw/excalidraw/blob/v0.18.1/packages/excalidraw/fonts/Liberation/index.ts) |

Retrieved 2026-09-08. Excalifont and ComicShanns notices are copied from embedded
name-table metadata recorded in the pinned Excalidraw v0.18.1 source. The other
OFL notices are copied from the font authors' repositories or Google Fonts'
author-attributed distribution. Their current copyright date ranges do not
claim that a newer font binary is bundled here; the actual binaries and their
embedded attribution remain the pinned package's bytes. Xiaolai SC is the
package's existing subset of the font now maintained at LXGW's kose-font
repository; no new subset transformation occurs in this app.

Liberation is the old GPL-with-font-exception version, not the later OFL
Liberation release. D2 diagrams are measured with Excalifont instead; see the
[Excalifont measurement notice](excalifont-measurement-NOTICE.md).

The [actual pinned name-table metadata](pinned-native-font-metadata.json) includes
original copyright notices, versions and complete embedded license text where
present, including Cascadia's original Microsoft/OFL-based text and Virgil's
original attribution. These supplement, rather than replace, embedded notices.

## Interface fonts

The app's own interface uses Space Grotesk ([OFL](Space-Grotesk-OFL.txt)) and
JetBrains Mono ([OFL](JetBrains-Mono-OFL.txt)), self-hosted from their
`@fontsource-variable` packages.
