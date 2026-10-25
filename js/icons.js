// 圖示：路徑取自 expense-design/mock.js（lucide 風格，stroke 2）。僅含 app 用到的子集。
const P = {
 "air": "<path d=\"M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z\"/>",
 "hotel": "<path d=\"M2 4v16\"/><path d=\"M2 8h18a2 2 0 0 1 2 2v10\"/><path d=\"M2 17h20\"/><path d=\"M6 8v9\"/>",
 "transport": "<path d=\"M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2\"/><circle cx=\"7\" cy=\"17\" r=\"2\"/><path d=\"M9 17h6\"/><circle cx=\"17\" cy=\"17\" r=\"2\"/>",
 "meals": "<path d=\"M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2\"/><path d=\"M7 2v20\"/><path d=\"M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7\"/>",
 "comm": "<rect x=\"5\" y=\"2\" width=\"14\" height=\"20\" rx=\"2\"/><path d=\"M12 18h.01\"/>",
 "misc": "<circle cx=\"12\" cy=\"12\" r=\"1\"/><circle cx=\"19\" cy=\"12\" r=\"1\"/><circle cx=\"5\" cy=\"12\" r=\"1\"/>",
 "camera": "<path d=\"M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z\"/><circle cx=\"12\" cy=\"13\" r=\"3\"/>",
 "pencil": "<path d=\"M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z\"/>",
 "right": "<path d=\"m9 18 6-6-6-6\"/>",
 "down": "<path d=\"m6 9 6 6 6-6\"/>",
 "left": "<path d=\"m15 18-6-6 6-6\"/>",
 "gear": "<circle cx=\"12\" cy=\"12\" r=\"3\"/><path d=\"M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1\"/>",
 "warn": "<path d=\"m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z\"/><path d=\"M12 9v4\"/><path d=\"M12 17h.01\"/>",
 "stop": "<polygon points=\"7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86\"/><path d=\"M12 8v4\"/><path d=\"M12 16h.01\"/>",
 "ok": "<circle cx=\"12\" cy=\"12\" r=\"10\"/><path d=\"m9 12 2 2 4-4\"/>",
 "receipt": "<path d=\"M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z\"/><path d=\"M16 8h-6\"/><path d=\"M16 12H8\"/><path d=\"M13 16H8\"/>",
 "users": "<path d=\"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2\"/><circle cx=\"9\" cy=\"7\" r=\"4\"/><path d=\"M22 21v-2a4 4 0 0 0-3-3.87\"/><path d=\"M16 3.13a4 4 0 0 1 0 7.75\"/>",
 "share": "<path d=\"M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8\"/><path d=\"m16 6-4-4-4 4\"/><path d=\"M12 2v13\"/>",
 "clock": "<circle cx=\"12\" cy=\"12\" r=\"10\"/><path d=\"M12 6v6l4 2\"/>",
 "plus": "<path d=\"M5 12h14\"/><path d=\"M12 5v14\"/>",
 "x": "<path d=\"M18 6 6 18\"/><path d=\"m6 6 12 12\"/>",
 "sheet": "<path d=\"M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z\"/><path d=\"M14 2v6h6\"/><path d=\"M8 13h8\"/><path d=\"M8 17h8\"/><path d=\"M10 9H8\"/>",
 "image": "<rect x=\"3\" y=\"3\" width=\"18\" height=\"18\" rx=\"2\"/><circle cx=\"9\" cy=\"9\" r=\"2\"/><path d=\"m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21\"/>",
 "card": "<rect x=\"2\" y=\"5\" width=\"20\" height=\"14\" rx=\"2\"/><path d=\"M2 10h20\"/>",
 "cal": "<rect x=\"3\" y=\"4\" width=\"18\" height=\"18\" rx=\"2\"/><path d=\"M16 2v4M8 2v4M3 10h18\"/>",
 "pin": "<path d=\"M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z\"/><circle cx=\"12\" cy=\"10\" r=\"3\"/>",
 "sparkle": "<path d=\"M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z\"/>",
 "briefcase": "<rect x=\"2\" y=\"7\" width=\"20\" height=\"14\" rx=\"2\"/><path d=\"M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16\"/>",
 "user": "<circle cx=\"12\" cy=\"8\" r=\"4\"/><path d=\"M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1\"/>",
 "flash": "<path d=\"M13 2 3 14h9l-1 8 10-12h-9l1-8z\"/>",
 "lock": "<rect x=\"3\" y=\"11\" width=\"18\" height=\"11\" rx=\"2\"/><path d=\"M7 11V7a5 5 0 0 1 10 0v4\"/>"
};
export const CAT_KEY = { 'Air ticket': 'air', Hotel: 'hotel', Transportation: 'transport', Meals: 'meals', Communication: 'comm', Misc: 'misc' };
export function icon(name, cls = '') {
  return `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;
}
