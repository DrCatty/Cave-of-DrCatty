// Classic 40-space board. Rent tables are the official US edition values:
// [base rent, 1 house, 2 houses, 3 houses, 4 houses, hotel].

export const GROUPS = {
  brown: { name: '棕色区', color: '#8d5524' },
  lightblue: { name: '浅蓝区', color: '#8ed2e6' },
  pink: { name: '粉紫区', color: '#d93a8c' },
  orange: { name: '橙区', color: '#ef7d1a' },
  red: { name: '红区', color: '#dc2626' },
  yellow: { name: '黄区', color: '#f2c500' },
  green: { name: '绿区', color: '#1c9e4d' },
  blue: { name: '深蓝区', color: '#2b5fd9' },
  rail: { name: '铁路', color: '#3f3f46' },
  utility: { name: '公用事业', color: '#64748b' },
};

/**
 * type: go | prop | rail | utility | chance | chest | tax | jail | parking | goto-jail
 * edge: bottom | left | top | right (used for the colored bar in the UI)
 */
export const BOARD = [
  { i: 0, type: 'go', name: '起点', short: 'START', edge: 'bottom' },
  { i: 1, type: 'prop', name: '地中海大道', short: '地中海', group: 'brown', price: 60, house: 50, rent: [2, 10, 30, 90, 160, 250], edge: 'bottom' },
  { i: 2, type: 'chest', name: '社区福利', short: '福利', edge: 'bottom' },
  { i: 3, type: 'prop', name: '波罗的海大道', short: '波罗的海', group: 'brown', price: 60, house: 50, rent: [4, 20, 60, 180, 320, 450], edge: 'bottom' },
  { i: 4, type: 'tax', name: '所得税', short: '所得税', amount: 200, edge: 'bottom' },
  { i: 5, type: 'rail', name: '雷丁铁路', short: '雷丁铁路', group: 'rail', price: 200, edge: 'bottom' },
  { i: 6, type: 'prop', name: '东方大道', short: '东方', group: 'lightblue', price: 100, house: 50, rent: [6, 30, 90, 270, 400, 550], edge: 'bottom' },
  { i: 7, type: 'chance', name: '机会', short: '机会', edge: 'bottom' },
  { i: 8, type: 'prop', name: '佛蒙特大道', short: '佛蒙特', group: 'lightblue', price: 100, house: 50, rent: [6, 30, 90, 270, 400, 550], edge: 'bottom' },
  { i: 9, type: 'prop', name: '康涅狄格大道', short: '康涅狄格', group: 'lightblue', price: 120, house: 50, rent: [8, 40, 100, 300, 450, 600], edge: 'bottom' },
  { i: 10, type: 'jail', name: '监狱 / 探监', short: '监狱', edge: 'left' },
  { i: 11, type: 'prop', name: '圣查尔斯广场', short: '圣查尔斯', group: 'pink', price: 140, house: 100, rent: [10, 50, 150, 450, 625, 750], edge: 'left' },
  { i: 12, type: 'utility', name: '电力公司', short: '电力', group: 'utility', price: 150, edge: 'left' },
  { i: 13, type: 'prop', name: '州立大道', short: '州立', group: 'pink', price: 140, house: 100, rent: [10, 50, 150, 450, 625, 750], edge: 'left' },
  { i: 14, type: 'prop', name: '弗吉尼亚大道', short: '弗吉尼亚', group: 'pink', price: 160, house: 100, rent: [12, 60, 180, 500, 700, 900], edge: 'left' },
  { i: 15, type: 'rail', name: '宾夕法尼亚铁路', short: '宾州铁路', group: 'rail', price: 200, edge: 'left' },
  { i: 16, type: 'prop', name: '圣詹姆斯广场', short: '圣詹姆斯', group: 'orange', price: 180, house: 100, rent: [14, 70, 200, 550, 750, 950], edge: 'left' },
  { i: 17, type: 'chest', name: '社区福利', short: '福利', edge: 'left' },
  { i: 18, type: 'prop', name: '田纳西大道', short: '田纳西', group: 'orange', price: 180, house: 100, rent: [14, 70, 200, 550, 750, 950], edge: 'left' },
  { i: 19, type: 'prop', name: '纽约大道', short: '纽约', group: 'orange', price: 200, house: 100, rent: [16, 80, 220, 600, 800, 1000], edge: 'left' },
  { i: 20, type: 'parking', name: '免费停车', short: '免费停车', edge: 'top' },
  { i: 21, type: 'prop', name: '肯塔基大道', short: '肯塔基', group: 'red', price: 220, house: 150, rent: [18, 90, 250, 700, 875, 1050], edge: 'top' },
  { i: 22, type: 'chance', name: '机会', short: '机会', edge: 'top' },
  { i: 23, type: 'prop', name: '印第安纳大道', short: '印第安纳', group: 'red', price: 220, house: 150, rent: [18, 90, 250, 700, 875, 1050], edge: 'top' },
  { i: 24, type: 'prop', name: '伊利诺伊大道', short: '伊利诺伊', group: 'red', price: 240, house: 150, rent: [20, 100, 300, 750, 925, 1100], edge: 'top' },
  { i: 25, type: 'rail', name: 'B&O 铁路', short: 'B&O 铁路', group: 'rail', price: 200, edge: 'top' },
  { i: 26, type: 'prop', name: '大西洋大道', short: '大西洋', group: 'yellow', price: 260, house: 150, rent: [22, 110, 330, 800, 975, 1150], edge: 'top' },
  { i: 27, type: 'prop', name: '文特诺大道', short: '文特诺', group: 'yellow', price: 260, house: 150, rent: [22, 110, 330, 800, 975, 1150], edge: 'top' },
  { i: 28, type: 'utility', name: '自来水厂', short: '自来水', group: 'utility', price: 150, edge: 'top' },
  { i: 29, type: 'prop', name: '马文花园', short: '马文花园', group: 'yellow', price: 280, house: 150, rent: [24, 120, 360, 850, 1025, 1200], edge: 'top' },
  { i: 30, type: 'goto-jail', name: '入狱', short: '入狱', edge: 'right' },
  { i: 31, type: 'prop', name: '太平洋大道', short: '太平洋', group: 'green', price: 300, house: 200, rent: [26, 130, 390, 900, 1100, 1275], edge: 'right' },
  { i: 32, type: 'prop', name: '北卡罗来纳大道', short: '北卡', group: 'green', price: 300, house: 200, rent: [26, 130, 390, 900, 1100, 1275], edge: 'right' },
  { i: 33, type: 'chest', name: '社区福利', short: '福利', edge: 'right' },
  { i: 34, type: 'prop', name: '宾夕法尼亚大道', short: '宾州大道', group: 'green', price: 320, house: 200, rent: [28, 150, 450, 1000, 1200, 1400], edge: 'right' },
  { i: 35, type: 'rail', name: '短线铁路', short: '短线铁路', group: 'rail', price: 200, edge: 'right' },
  { i: 36, type: 'chance', name: '机会', short: '机会', edge: 'right' },
  { i: 37, type: 'prop', name: '公园广场', short: '公园广场', group: 'blue', price: 350, house: 200, rent: [35, 175, 500, 1100, 1300, 1500], edge: 'right' },
  { i: 38, type: 'tax', name: '奢侈税', short: '奢侈税', amount: 100, edge: 'right' },
  { i: 39, type: 'prop', name: '木板路', short: '木板路', group: 'blue', price: 400, house: 200, rent: [50, 200, 600, 1400, 1700, 2000], edge: 'right' },
];

export const GROUP_MEMBERS = BOARD.reduce((acc, space) => {
  if (space.group) (acc[space.group] ||= []).push(space.i);
  return acc;
}, {});

export const COLOR_GROUPS = ['brown', 'lightblue', 'pink', 'orange', 'red', 'yellow', 'green', 'blue'];

export const RAILS = GROUP_MEMBERS.rail;
export const UTILITIES = GROUP_MEMBERS.utility;

/** Grid cell (row, col) on an 11x11 board, 1-based, matching a normal board layout. */
export function gridPos(i) {
  if (i === 0) return { row: 11, col: 11 };
  if (i < 10) return { row: 11, col: 11 - i };
  if (i === 10) return { row: 11, col: 1 };
  if (i < 20) return { row: 11 - (i - 10), col: 1 };
  if (i === 20) return { row: 1, col: 1 };
  if (i < 30) return { row: 1, col: 1 + (i - 20) };
  if (i === 30) return { row: 1, col: 11 };
  return { row: 1 + (i - 30), col: 11 };
}

export function rentFor(space, owner, owners, diceTotal) {
  if (space.type === 'prop') {
    const owned = owners[space.i];
    const houses = owned.houses;
    if (houses > 0) return space.rent[houses];
    const group = GROUP_MEMBERS[space.group];
    const monopoly = group.every((idx) => owners[idx] && owners[idx].owner === owner);
    return monopoly ? space.rent[0] * 2 : space.rent[0];
  }
  if (space.type === 'rail') {
    const count = RAILS.filter((idx) => owners[idx] && owners[idx].owner === owner).length;
    return [0, 25, 50, 100, 200][count];
  }
  if (space.type === 'utility') {
    const count = UTILITIES.filter((idx) => owners[idx] && owners[idx].owner === owner).length;
    return count === 2 ? diceTotal * 10 : diceTotal * 4;
  }
  return 0;
}

export function isBuildable(space) {
  return space.type === 'prop';
}

export function maxHouseLevel(space) {
  return space.type === 'prop' ? 5 : 0;
}
