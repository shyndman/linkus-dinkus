import assert from "node:assert/strict";
import { basename } from "node:path";
import test from "node:test";
import { getUrlSnapshotDirectory } from "../src/runtime.ts";

const URL_SLUG_CASES = [
  {
    url: "https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=b0f3dbb9-c0c3-450e-b942-8ef0c3d60ac5&ccId=19000101_000001&lang=en_CA",
    slug: "https-workforcenow-adp-com-mascsr-default-mdf-recruitment-recruitment-html-cid-b0f3dbb9-c0c3-450e-b942-8ef0c3d60ac5-ccid-19000101-000001-lang-en-ca",
  },
  {
    url: "https://careers.airbnb.com/positions/?_where_you_work=canada%2Calberta-canada-british-columbia-canada%2Contario-canada",
    slug: "https-careers-airbnb-com-positions-where-you-work-canada-2calberta-canada-british-columbia-canada-2contario-canada",
  },
  {
    url: "https://www.vancouverfoundation.ca/about-us/get-involved/careers/?gad_source=1&gad_campaignid=9616826095&gbraid=0AAAAADq9WWNmi5Y6rkkP1SmI6zMqjMZEN&gclid=Cj0KCQjwteTUBhD4ARIsAEYjs3qkUy05Rp2Px_qpSUOQjlOXF1eHRt4U5nQkABjVtdAvrtwiQ0JkHcMaAgvnEALw_wcB",
    slug: "https-www-vancouverfoundation-ca-about-us-get-involved-careers-gad-source-1-gad-campaignid-9616826095-gbraid-0aaaaadq9wwnmi5y6rkkp1smi6zmqjmzen-gclid-cj0kcqjwtetubhd4arisaeyjs3qkuy05rp2px-qpsuoqjloxf1ehrt4u5nqkabjvtdavrtwiq0jkhcmaagvnealw-wcb",
  },
] as const;

test("maps watched URLs to their existing snapshot directories", async (): Promise<void> => {
  for (const { url, slug } of URL_SLUG_CASES) {
    assert.equal(basename(await getUrlSnapshotDirectory(url)), slug);
  }
});
