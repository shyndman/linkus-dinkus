import { readFileSync } from 'fs';
import * as cheerio from 'cheerio';
const html = readFileSync(process.argv[2], 'utf8');
const $ = cheerio.load(html);
const el = $('sdf-link[id="lblTitle_9201788796213_1"]');
console.log('TAG', el.prop('tagName'));
console.log('PARENT tag', el.parent().get(0)?.tagName, el.parent().attr('class'));
console.log('GP tag', el.parent().parent().get(0)?.tagName, el.parent().parent().attr('class'));
const htmlStr = html;
console.log('req count', (htmlStr.match(/9201788796213/g)||[]).length);
console.log('requisitionId', htmlStr.includes('requisitionId'));
console.log('reqId', htmlStr.includes('reqId'));
console.log('jobPostingId', htmlStr.includes('jobPostingId'));
// capture surrounding container outer html
const cont = el.parent().parent().parent().parent();
console.log('CONTAINER:', cont.get(0)?.tagName, cont.attr('class'));
console.log('CONTAINER HTML:\n', cont.html().slice(0,2500));
