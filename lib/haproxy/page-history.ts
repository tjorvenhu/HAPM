/**
 * Die Prüfsummen der Fehlerdateien, die HAPM in früheren Fassungen ohne eigenes
 * Design geschrieben hat („Standard“), je Sprache und Status.
 *
 * ── Wofür ──
 *
 * HAPM zieht eine Fehlerdatei selbst nach (`isOwnErrorFile` in
 * `error-pages.ts`), wenn sie genau das ist, was HAPM zuletzt geschrieben hat.
 * Das merkt sich die Collection `page_files`, aber erst seit dieser Fassung.
 * Eine Installation von vorher hat dort nichts. Für sie gilt: eine Datei, die
 * Byte für Byte eine frühere Standardseite ist, hat niemand von Hand gebaut,
 * und sie darf ersetzt werden.
 *
 * ── Woher die Zahlen kommen ──
 *
 * Gerechnet mit `errorFiles()` der jeweiligen Fassung, über jeden Commit der
 * Geschichte: es gibt genau zwei frühere Fassungen und die jetzige. Fassungen
 * mit eigenem Design („Selbst gestalten“) stehen nicht hier, ihre Dateien
 * kennt nur `page_files`. Die Passwortabfrage fehlt ebenfalls: ihre Seiten
 * schreibt HAPM ohnehin bei jeder Abweichung neu (`ensureLockPages`).
 *
 * ── Wenn sich die Standardseite ändert ──
 *
 * Die neuen Zahlen kommen dazu, die alten bleiben. Der Test in
 * `tests/haproxy/page-files.test.ts` scheitert, solange die jetzige Seite hier
 * fehlt.
 */

/** 0.2.0 bis 0.4.x (nur deutsch) und 0.5.x (deutsch und englisch, die deutsche Fassung ist dieselbe). */
const UNTIL_0_5: Record<string, string> = {
  'de-400': 'b763f35d1aced1aaba9d534b1211bd2b00f2efa9f92366a33a037c9c9cac9f80',
  'de-401': '9369781264a80c04467ba8cf7c28f382c228ca7cfba1cbc184a8fbd6f4b3c4b9',
  'de-403': 'a8aa339c4f115395d871771cb0c3d09c77fdaf25ea95698cd30c70b7d588be2d',
  'de-404': '9c263ffcf2c7bd2f1e120928160a212a62a64c723cf32155c35842c16e1270f3',
  'de-405': '18f3f19b55a8c2b6f807d008bbf7124b9acf154e3572789d134c6db9c2ad42fc',
  'de-408': '13aec7404d52bfed2e3586d1d22ab860cd9a55d4657dc050bf8dbeab7059fb49',
  'de-410': '0d038d529bc0d8d275e2519c8e4c6a29acd33ea1c0ea0f6c8133c8cd0a08f9f2',
  'de-413': 'c1241bbdb30d27100c00f5385f6bee0564f48f0fd7b82ba448faf87e657b0a02',
  'de-429': 'dd73605a8ea9aaa577e67f40b0627ca5958ca7617ecce47ee46f49628c16fa51',
  'de-500': 'd1d82662fa2cee52034972aea2ea6edff57485f91c8d766c849ee39912a71db3',
  'de-501': '22e3d545620fbb0451955f9e62e94a038fc89124fdbdfe1db15334edbacfb407',
  'de-502': '742a0c0292209688ccfd2769cd4c48df91cb76d7be38a66183aee06774331ce5',
  'de-503': '332cfdbdbac9c4e8d80463645ae382a3544cc1318988878ae01fe8e0a0734958',
  'de-504': '011a56773185f44c38532005d2389832750f1ab794d81e2ec87bebba51ea7651',
  'en-400': '558548d95f250fbcce01becfdf45597c844329d4d0381c12c24fea3eba2ba164',
  'en-401': 'b932a0067bde46764e2d0ad594767b24a0a6f49d7da2afcc05a8ef380e6857ca',
  'en-403': 'faa4166c0c575b76a11dc9308e003b6cb311346c05b4c73cb91c5a56204f0e5b',
  'en-404': 'c58f8f51565cd9e5e7100b26ad3ac041205b33af37a4ee5987b9dbcafb34989d',
  'en-405': 'a620b6a845dcea29bfb86b76a8093d68dc134637569d2abcc4115bc3980e5c95',
  'en-408': 'dc815fb5a27e7ede6befc5d715a27280bbb5f32bbc9d0b2907f56841f108074a',
  'en-410': 'cbc21d9cc76ef01aedd27ed0529845b7bb03b0ab7207c5bf5c9f263255bdf6f1',
  'en-413': 'c146572106cff522a931db9bf3ba7d1e02b3050a7b6e88451914d2476c17bfbd',
  'en-429': '829b3f07a7f14cca8f96c4fcbcd7ba3b7b3d123119b1d8f476ce0a0752d73e6c',
  'en-500': '295adffa25c153b17f96ca5e346beeaa708a7a86a2b12b174889e3c45326c3cb',
  'en-501': 'a8fa0e0b5afccb423b423cf10cc331ca8a4324c7fba9970c9f5bafe069e2c0b2',
  'en-502': 'a6df7454aaa0f69d5b90009318f3013dc40e6e8ef5ef09f02d4959fefc1b65d7',
  'en-503': '9d87a81aeedad5d3903ddb4609796470562f1158d9020e77e5d105629fcdb402',
  'en-504': '7eb88c6d3abeda6d8d69f05f6d0169a94da4eef1ff31ded171e454caa8bd9d7e',
};

/** 0.6.0 bis zur Darstellung in den Seiten: die Seite in der Schrift des Systems, hell und dunkel. */
const SINCE_0_6: Record<string, string> = {
  'de-400': '6b671ff1f4846d68d83dc238d4908f203232757130d5c303f8bd562fd6409569',
  'de-401': 'bcaba2cae133aca070a5d97e97e0b7921a39ee0f8ae98a21c24e9d3824577290',
  'de-403': 'f5f228ec9cf17b33254d3d905aefdd86cdf310c01715ff1b007657463eee7ac1',
  'de-404': 'bbc9333629b5dbd0e2fc171208608ccb97b1227e00256e1db003b3acc324fa4f',
  'de-405': '5afac10d53179226859e9d4e8fd0fff25c90046a8944387b8faee72219fdc3d8',
  'de-408': 'd70ca461075e4997beaa5f993dc24403f0eccaa7cd99de3097ac3e1b079d3d11',
  'de-410': '258bba2a58dbeb200eb0d2950db8da77fb75739dc919fe2f378ab3f2c2991954',
  'de-413': '2c04183e09ceb35ebd4911f8a3b2d045941f9bf1341ba87b791d76af72ae7d98',
  'de-429': '76669b3a0a42597abea969b18d56a34d06d04fcee3d46e6dd61c31398130d5ba',
  'de-500': 'e6453d496a5a56f5eb458ed31ad8b8c1c9f5aba9f71cdf4a8d606c81c336bedb',
  'de-501': '25bf84c6bdfb399dc7aa23132833b18e487296d235cd9cc4fbc138a80980c1b1',
  'de-502': 'ec38ffdc252b4a0a8f7ff6627656612d545a08b123400bc58bf3df9ed243307f',
  'de-503': '0acf73df7e2784feb9fd7cca6e99b46d02035ce6facde77af93051898401b03c',
  'de-504': '474944f8940bb1b63b9b4b7f9b3b04c4d787e94e4ec37a219dbc7fb4d9ff3dbb',
  'en-400': 'd6d303fa57b3e2c4fa178dd8fd9fda08b76e28c117bad70e08a83f89f352f0b5',
  'en-401': '3e04ceca51e95d1a8c0ac39fb2f9569a50b632799c62d59adfcf77829f2e3b39',
  'en-403': '529a926938172dcd0f6435a8d72f9e3a85ba1f6887af1158b6195336b8f301df',
  'en-404': '8c646b91b8ddd176d4178eeda59b0421e602ef2c3455ba3ecb416fe83a2d0b2e',
  'en-405': '22de822bcd4e3e5cf413be688fef4f6e890bb7f14741cbd801ba2bba7c896d97',
  'en-408': '5d70d48661816091858b7136e9bd9e03a26c8fa23b28de523486217c9feacf3b',
  'en-410': '6077edcf82bfe7f2de02e0e58485e8ab0ceb2b8623587aa836648a17177755e4',
  'en-413': 'd1bdbcde484b6d8f62dc6a7c5c798be972aa8590c65e5a3c616008dd2133e194',
  'en-429': 'db6ccfe267ef97c1d0844d95e39127ad10d28ff9392a1a0b5a924b5b785809b8',
  'en-500': '03feb35ad923a85bbae84e8c8d57730f1b43b1d631c95c923cf856913c25bf86',
  'en-501': 'd2a75d83345690cfa33687392e9ae3f0570752fbede5115b23807fd09428baff',
  'en-502': 'eb544cef6d6c2615c34e182ce89164222e1232454a10d7fca209eb1288a51175',
  'en-503': '301d852f80a710230ab6278c27085f7d70ce8ab172bdcce4fd0a87177ab33465',
  'en-504': '1e1e94ef0fe5fac5b1940acab690f02472ef812633a01b5480f55fd993d41f3d',
};

const FORMER_STANDARD = new Set([...Object.values(UNTIL_0_5), ...Object.values(SINCE_0_6)]);

/** Ob eine Datei Byte für Byte eine Standardseite einer früheren oder der jetzigen Fassung ist. */
export function isFormerStandardPage(digest: string): boolean {
  return FORMER_STANDARD.has(digest);
}
