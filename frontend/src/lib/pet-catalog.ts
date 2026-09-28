import { publicAssetBaseUrl } from './public-assets'

export type PetId = string

export interface PetCatalogEntry {
  id: PetId
  slug: string
  name: string
  spritesheetUrl: string
  tags: string[]
}

const R2 = publicAssetBaseUrl()

export const PET_CATALOG: PetCatalogEntry[] = [
  // ── 动漫/游戏角色 ──
  { id: 'aaruna', slug: 'aaruna', name: '阿露娜', spritesheetUrl: `${R2}/pets/aaruna.webp`, tags: ['动漫'] },
  { id: 'agumon', slug: 'agumon', name: '亚古兽', spritesheetUrl: `${R2}/pets/agumon.webp`, tags: ['动漫'] },
  { id: 'akane', slug: 'akane', name: '茜', spritesheetUrl: `${R2}/pets/akane.webp`, tags: ['动漫'] },
  { id: 'bichon', slug: 'bichon', name: '熊熊', spritesheetUrl: `${R2}/pets/bichon.webp`, tags: ['动漫'] },
  { id: 'bubu', slug: 'bubu', name: '布布', spritesheetUrl: `${R2}/pets/bubu.webp`, tags: ['动漫'] },
  { id: 'bubu-2', slug: 'bubu-2', name: '布布熊', spritesheetUrl: `${R2}/pets/bubu-2.webp`, tags: ['动漫'] },
  { id: 'bubu-3', slug: 'bubu-3', name: '布布兔', spritesheetUrl: `${R2}/pets/bubu-3.webp`, tags: ['动漫'] },
  { id: 'chiikawa', slug: 'chiikawa', name: '吉伊卡哇', spritesheetUrl: `${R2}/pets/chiikawa.webp`, tags: ['动漫'] },
  { id: 'digimon-2', slug: 'digimon-2', name: '数码宝贝', spritesheetUrl: `${R2}/pets/digimon-2.webp`, tags: ['动漫'] },
  { id: 'duck-jiji', slug: 'duck-jiji', name: '鸭吉吉', spritesheetUrl: `${R2}/pets/duck-jiji.webp`, tags: ['动漫'] },
  { id: 'faye', slug: 'faye', name: '菲·瓦伦坦', spritesheetUrl: `${R2}/pets/faye.webp`, tags: ['动漫'] },
  { id: 'frieren', slug: 'frieren', name: '芙莉莲', spritesheetUrl: `${R2}/pets/frieren.webp`, tags: ['动漫'] },
  { id: 'frieren-3', slug: 'frieren-3', name: '芙莉莲 (2)', spritesheetUrl: `${R2}/pets/frieren-3.webp`, tags: ['动漫'] },
  { id: 'gallantmon', slug: 'gallantmon', name: '松狮兽', spritesheetUrl: `${R2}/pets/gallantmon.webp`, tags: ['动漫'] },
  { id: 'gojo', slug: 'gojo', name: '五条悟', spritesheetUrl: `${R2}/pets/gojo.webp`, tags: ['动漫'] },
  { id: 'harry-poptart', slug: 'harry-poptart', name: '哈利·波普', spritesheetUrl: `${R2}/pets/harry-poptart.webp`, tags: ['动漫'] },
  { id: 'itachi', slug: 'itachi', name: '鼬', spritesheetUrl: `${R2}/pets/itachi.webp`, tags: ['动漫'] },
  { id: 'keqing', slug: 'keqing', name: '刻晴', spritesheetUrl: `${R2}/pets/keqing.webp`, tags: ['动漫'] },
  { id: 'kiki', slug: 'kiki', name: '琪琪', spritesheetUrl: `${R2}/pets/kiki.webp`, tags: ['动漫'] },
  { id: 'kuromi', slug: 'kuromi', name: '库洛米', spritesheetUrl: `${R2}/pets/kuromi.webp`, tags: ['动漫'] },
  { id: 'kyojuro-rengoku', slug: 'kyojuro-rengoku', name: '炼狱杏寿郎', spritesheetUrl: `${R2}/pets/kyojuro-rengoku.webp`, tags: ['动漫'] },
  { id: 'luffy', slug: 'luffy', name: '路飞', spritesheetUrl: `${R2}/pets/luffy.webp`, tags: ['动漫'] },
  { id: 'luffy-2', slug: 'luffy-2', name: '路飞 (2)', spritesheetUrl: `${R2}/pets/luffy-2.webp`, tags: ['动漫'] },
  { id: 'maodie', slug: 'maodie', name: '圆头耄耋', spritesheetUrl: `${R2}/pets/maodie.webp`, tags: ['动漫'] },
  { id: 'miaomiao-codex', slug: 'miaomiao-codex', name: '喵喵', spritesheetUrl: `${R2}/pets/miaomiao-codex.webp`, tags: ['动漫'] },
  { id: 'mimi-love', slug: 'mimi-love', name: '咪咪', spritesheetUrl: `${R2}/pets/mimi-love.webp`, tags: ['动漫'] },
  { id: 'naruto', slug: 'naruto', name: '鸣人', spritesheetUrl: `${R2}/pets/naruto.webp`, tags: ['动漫'] },
  { id: 'nezuko', slug: 'nezuko', name: '祢豆子', spritesheetUrl: `${R2}/pets/nezuko.webp`, tags: ['动漫'] },
  { id: 'nezukocoder', slug: 'nezukocoder', name: '祢豆子·编程版', spritesheetUrl: `${R2}/pets/nezukocoder.webp`, tags: ['动漫'] },
  { id: 'oiioi', slug: 'oiioi', name: 'Oiioi', spritesheetUrl: `${R2}/pets/oiioi.webp`, tags: ['动漫'] },
  { id: 'rock-kingdom-daeermaodou', slug: 'rock-kingdom-daeermaodou', name: '洛克王国·大耳毛豆', spritesheetUrl: `${R2}/pets/rock-kingdom-daeermaodou.webp`, tags: ['动漫'] },
  { id: 'sabo', slug: 'sabo', name: '萨博', spritesheetUrl: `${R2}/pets/sabo.webp`, tags: ['动漫'] },
  { id: 'sayu', slug: 'sayu', name: '早柚', spritesheetUrl: `${R2}/pets/sayu.webp`, tags: ['动漫'] },
  { id: 'shinchan', slug: 'shinchan', name: '蜡笔小新', spritesheetUrl: `${R2}/pets/shinchan.webp`, tags: ['动漫'] },
  { id: 'shinobu', slug: 'shinobu', name: '蝴蝶忍', spritesheetUrl: `${R2}/pets/shinobu.webp`, tags: ['动漫'] },
  { id: 'skirk-2', slug: 'skirk-2', name: '丝柯克', spritesheetUrl: `${R2}/pets/skirk-2.webp`, tags: ['动漫'] },
  { id: 'slayer', slug: 'slayer', name: ' Slayer', spritesheetUrl: `${R2}/pets/slayer.webp`, tags: ['动漫'] },
  { id: 'sukuna', slug: 'sukuna', name: '宿傩', spritesheetUrl: `${R2}/pets/sukuna.webp`, tags: ['动漫'] },
  { id: 'totoro', slug: 'totoro', name: '龙猫', spritesheetUrl: `${R2}/pets/totoro.webp`, tags: ['动漫'] },
  { id: 'usagi', slug: 'usagi', name: '月野兔', spritesheetUrl: `${R2}/pets/usagi.webp`, tags: ['动漫'] },
  { id: 'wall-e-baby', slug: 'wall-e-baby', name: '瓦力宝宝', spritesheetUrl: `${R2}/pets/wall-e-baby.webp`, tags: ['动漫'] },
  { id: 'wukong', slug: 'wukong', name: '悟空', spritesheetUrl: `${R2}/pets/wukong.webp`, tags: ['动漫'] },
  { id: 'xiao-tian', slug: 'xiao-tian', name: '小天', spritesheetUrl: `${R2}/pets/xiao-tian.webp`, tags: ['动漫'] },
  { id: 'xiaoyao', slug: 'xiaoyao', name: '逍遥', spritesheetUrl: `${R2}/pets/xiaoyao.webp`, tags: ['动漫'] },
  { id: 'xueying-wawa', slug: 'xueying-wawa', name: '雪影娃娃', spritesheetUrl: `${R2}/pets/xueying-wawa.webp`, tags: ['动漫'] },
  { id: 'zoro', slug: 'zoro', name: '索隆', spritesheetUrl: `${R2}/pets/zoro.webp`, tags: ['动漫'] },

  // ── 萌宠/动物 ──
  { id: 'aoxiaotiger', slug: 'aoxiaotiger', name: '傲小虎', spritesheetUrl: `${R2}/pets/aoxiaotiger.webp`, tags: ['动物'] },
  { id: 'apupepe', slug: 'apupepe', name: '青蛙Pepe', spritesheetUrl: `${R2}/pets/apupepe.webp`, tags: ['动物'] },
  { id: 'baby-milo', slug: 'baby-milo', name: 'Baby Milo', spritesheetUrl: `${R2}/pets/baby-milo.webp`, tags: ['动物'] },
  { id: 'byte-bunny', slug: 'byte-bunny', name: '字节兔', spritesheetUrl: `${R2}/pets/byte-bunny.webp`, tags: ['动物'] },
  { id: 'cache-capy', slug: 'cache-capy', name: '水豚', spritesheetUrl: `${R2}/pets/cache-capy.webp`, tags: ['动物'] },
  { id: 'calico', slug: 'calico', name: '三花猫', spritesheetUrl: `${R2}/pets/calico.webp`, tags: ['动物'] },
  { id: 'capybaralulu', slug: 'capybaralulu', name: '水豚噜噜', spritesheetUrl: `${R2}/pets/capybaralulu.webp`, tags: ['动物'] },
  { id: 'chirayu', slug: 'chirayu', name: '奇拉尤', spritesheetUrl: `${R2}/pets/chirayu.webp`, tags: ['动物'] },
  { id: 'chonk', slug: 'chonk', name: '胖猫', spritesheetUrl: `${R2}/pets/chonk.webp`, tags: ['动物'] },
  { id: 'cloudy', slug: 'cloudy', name: '云朵', spritesheetUrl: `${R2}/pets/cloudy.webp`, tags: ['动物'] },
  { id: 'cream-cat', slug: 'cream-cat', name: '奶油猫', spritesheetUrl: `${R2}/pets/cream-cat.webp`, tags: ['动物'] },
  { id: 'crab-buddy', slug: 'crab-buddy', name: '螃蟹伙伴', spritesheetUrl: `${R2}/pets/crab-buddy.webp`, tags: ['动物'] },
  { id: 'custard', slug: 'custard', name: '卡仕达', spritesheetUrl: `${R2}/pets/custard.webp`, tags: ['动物'] },
  { id: 'daisy', slug: 'daisy', name: '雏菊', spritesheetUrl: `${R2}/pets/daisy.webp`, tags: ['动物'] },
  { id: 'dewsnail', slug: 'dewsnail', name: '露珠蜗牛', spritesheetUrl: `${R2}/pets/dewsnail.webp`, tags: ['动物'] },
  { id: 'figaro-2', slug: 'figaro-2', name: '费加罗', spritesheetUrl: `${R2}/pets/figaro-2.webp`, tags: ['动物'] },
  { id: 'fine-pup', slug: 'fine-pup', name: '好狗狗', spritesheetUrl: `${R2}/pets/fine-pup.webp`, tags: ['动物'] },
  { id: 'foxat', slug: 'foxat', name: '小狐狸', spritesheetUrl: `${R2}/pets/foxat.webp`, tags: ['动物'] },
  { id: 'foxcloud', slug: 'foxcloud', name: '云狐', spritesheetUrl: `${R2}/pets/foxcloud.webp`, tags: ['动物'] },
  { id: 'froge-openai-mascot', slug: 'froge-openai-mascot', name: '青蛙仔', spritesheetUrl: `${R2}/pets/froge-openai-mascot.webp`, tags: ['动物'] },
  { id: 'froggle', slug: 'froggle', name: '蛙蛙', spritesheetUrl: `${R2}/pets/froggle.webp`, tags: ['动物'] },
  { id: 'golden-retriever', slug: 'golden-retriever', name: '金毛', spritesheetUrl: `${R2}/pets/golden-retriever.webp`, tags: ['动物'] },
  { id: 'happy-cat', slug: 'happy-cat', name: '快乐猫', spritesheetUrl: `${R2}/pets/happy-cat.webp`, tags: ['动物'] },
  { id: 'kiradragon', slug: 'kiradragon', name: '奇拉龙', spritesheetUrl: `${R2}/pets/kiradragon.webp`, tags: ['动物'] },
  { id: 'kuro-2', slug: 'kuro-2', name: '小黑', spritesheetUrl: `${R2}/pets/kuro-2.webp`, tags: ['动物'] },
  { id: 'mochi', slug: 'mochi', name: '麻薯', spritesheetUrl: `${R2}/pets/mochi.webp`, tags: ['动物'] },
  { id: 'mochi-2', slug: 'mochi-2', name: '麻薯 (2)', spritesheetUrl: `${R2}/pets/mochi-2.webp`, tags: ['动物'] },
  { id: 'mochi-4', slug: 'mochi-4', name: '小麻薯', spritesheetUrl: `${R2}/pets/mochi-4.webp`, tags: ['动物'] },
  { id: 'nightly-fox', slug: 'nightly-fox', name: '夜狐', spritesheetUrl: `${R2}/pets/nightly-fox.webp`, tags: ['动物'] },
  { id: 'ninjacat', slug: 'ninjacat', name: '忍者猫', spritesheetUrl: `${R2}/pets/ninjacat.webp`, tags: ['动物'] },
  { id: 'nyako-shigure-2', slug: 'nyako-shigure-2', name: '猫时雨', spritesheetUrl: `${R2}/pets/nyako-shigure-2.webp`, tags: ['动物'] },
  { id: 'peanut', slug: 'peanut', name: '花生', spritesheetUrl: `${R2}/pets/peanut.webp`, tags: ['动物'] },
  { id: 'pepe', slug: 'pepe', name: 'Pepe', spritesheetUrl: `${R2}/pets/pepe.webp`, tags: ['动物'] },
  { id: 'peri-the-owl', slug: 'peri-the-owl', name: '小猫头鹰', spritesheetUrl: `${R2}/pets/peri-the-owl.webp`, tags: ['动物'] },
  { id: 'phoebe', slug: 'phoebe', name: '菲比', spritesheetUrl: `${R2}/pets/phoebe.webp`, tags: ['动物'] },
  { id: 'piggy', slug: 'piggy', name: '小猪', spritesheetUrl: `${R2}/pets/piggy.webp`, tags: ['动物'] },
  { id: 'pixel-panda', slug: 'pixel-panda', name: '像素熊猫', spritesheetUrl: `${R2}/pets/pixel-panda.webp`, tags: ['动物'] },
  { id: 'ralf', slug: 'ralf', name: '拉尔夫', spritesheetUrl: `${R2}/pets/ralf.webp`, tags: ['动物'] },
  { id: 'roxy', slug: 'roxy', name: '洛克西', spritesheetUrl: `${R2}/pets/roxy.webp`, tags: ['动物'] },
  { id: 'sea-lion', slug: 'sea-lion', name: '海狮', spritesheetUrl: `${R2}/pets/sea-lion.webp`, tags: ['动物'] },
  { id: 'shellbyte', slug: 'shellbyte', name: '贝壳', spritesheetUrl: `${R2}/pets/shellbyte.webp`, tags: ['动物'] },
  { id: 'shelly', slug: 'shelly', name: '雪莉', spritesheetUrl: `${R2}/pets/shelly.webp`, tags: ['动物'] },
  { id: 'super-piglet', slug: 'super-piglet', name: '超级小猪', spritesheetUrl: `${R2}/pets/super-piglet.webp`, tags: ['动物'] },
  { id: 'taro', slug: 'taro', name: '芋头', spritesheetUrl: `${R2}/pets/taro.webp`, tags: ['动物'] },
  { id: 'teddy', slug: 'teddy', name: '泰迪', spritesheetUrl: `${R2}/pets/teddy.webp`, tags: ['动物'] },
  { id: 'xiaobai', slug: 'xiaobai', name: '小白', spritesheetUrl: `${R2}/pets/xiaobai.webp`, tags: ['动物'] },

  // ── 趣味/搞怪 ──
  { id: 'academicasi', slug: 'academicasi', name: '学术ASI', spritesheetUrl: `${R2}/pets/academicasi.webp`, tags: ['搞怪'] },
  { id: 'academicasi-2', slug: 'academicasi-2', name: '学术ASI·法师', spritesheetUrl: `${R2}/pets/academicasi-2.webp`, tags: ['搞怪'] },
  { id: 'ada-lovelace', slug: 'ada-lovelace', name: 'Ada Lovelace', spritesheetUrl: `${R2}/pets/ada-lovelace.webp`, tags: ['搞怪'] },
  { id: 'black-dragon-pet', slug: 'black-dragon-pet', name: '黑龙', spritesheetUrl: `${R2}/pets/black-dragon-pet.webp`, tags: ['搞怪'] },
  { id: 'boba', slug: 'boba', name: '波霸奶茶', spritesheetUrl: `${R2}/pets/boba.webp`, tags: ['搞怪'] },
  { id: 'boshan-v6', slug: 'boshan-v6', name: '博山', spritesheetUrl: `${R2}/pets/boshan-v6.webp`, tags: ['搞怪'] },
  { id: 'boxcat', slug: 'boxcat', name: '盒猫', spritesheetUrl: `${R2}/pets/boxcat.webp`, tags: ['搞怪'] },
  { id: 'buff-patrick', slug: 'buff-patrick', name: '肌肉派大星', spritesheetUrl: `${R2}/pets/buff-patrick.webp`, tags: ['搞怪'] },
  { id: 'carro-real', slug: 'carro-real', name: '卡洛', spritesheetUrl: `${R2}/pets/carro-real.webp`, tags: ['搞怪'] },
  { id: 'chef', slug: 'chef', name: '大厨', spritesheetUrl: `${R2}/pets/chef.webp`, tags: ['搞怪'] },
  { id: 'cinnamonroll', slug: 'cinnamonroll', name: '大耳狗', spritesheetUrl: `${R2}/pets/cinnamonroll.webp`, tags: ['搞怪'] },
  { id: 'clippy', slug: 'clippy', name: '回形针', spritesheetUrl: `${R2}/pets/clippy.webp`, tags: ['搞怪'] },
  { id: 'crystal-maiden', slug: 'crystal-maiden', name: '水晶女郎', spritesheetUrl: `${R2}/pets/crystal-maiden.webp`, tags: ['搞怪'] },
  { id: 'diamondhead', slug: 'diamondhead', name: '钻石头', spritesheetUrl: `${R2}/pets/diamondhead.webp`, tags: ['搞怪'] },
  { id: 'dobby', slug: 'dobby', name: '多比', spritesheetUrl: `${R2}/pets/dobby.webp`, tags: ['搞怪'] },
  { id: 'dumpster-fire', slug: 'dumpster-fire', name: '垃圾桶着火', spritesheetUrl: `${R2}/pets/dumpster-fire.webp`, tags: ['搞怪'] },
  { id: 'eigenblob', slug: 'eigenblob', name: 'Eigenblob', spritesheetUrl: `${R2}/pets/eigenblob.webp`, tags: ['搞怪'] },
  { id: 'einstein', slug: 'einstein', name: '爱因斯坦', spritesheetUrl: `${R2}/pets/einstein.webp`, tags: ['搞怪'] },
  { id: 'elfie', slug: 'elfie', name: '小精灵', spritesheetUrl: `${R2}/pets/elfie.webp`, tags: ['搞怪'] },
  { id: 'elyndex', slug: 'elyndex', name: 'Elyndex', spritesheetUrl: `${R2}/pets/elyndex.webp`, tags: ['搞怪'] },
  { id: 'firebaby', slug: 'firebaby', name: '火宝宝', spritesheetUrl: `${R2}/pets/firebaby.webp`, tags: ['搞怪'] },
  { id: 'frankie', slug: 'frankie', name: '弗兰基', spritesheetUrl: `${R2}/pets/frankie.webp`, tags: ['搞怪'] },
  { id: 'ganesh', slug: 'ganesh', name: '象神', spritesheetUrl: `${R2}/pets/ganesh.webp`, tags: ['搞怪'] },
  { id: 'ghostface', slug: 'ghostface', name: '鬼脸', spritesheetUrl: `${R2}/pets/ghostface.webp`, tags: ['搞怪'] },
  { id: 'hal-9000', slug: 'hal-9000', name: 'HAL 9000', spritesheetUrl: `${R2}/pets/hal-9000.webp`, tags: ['搞怪'] },
  { id: 'jesus', slug: 'jesus', name: '耶稣', spritesheetUrl: `${R2}/pets/jesus.webp`, tags: ['搞怪'] },
  { id: 'kuro-love', slug: 'kuro-love', name: '小黑爱心', spritesheetUrl: `${R2}/pets/kuro-love.webp`, tags: ['搞怪'] },
  { id: 'maduro-tech-pet', slug: 'maduro-tech-pet', name: '科技宠', spritesheetUrl: `${R2}/pets/maduro-tech-pet.webp`, tags: ['搞怪'] },
  { id: 'marmalade', slug: 'marmalade', name: '果酱猫', spritesheetUrl: `${R2}/pets/marmalade.webp`, tags: ['搞怪'] },
  { id: 'mini-dark-lord', slug: 'mini-dark-lord', name: '小黑魔王', spritesheetUrl: `${R2}/pets/mini-dark-lord.webp`, tags: ['搞怪'] },
  { id: 'mini-elon', slug: 'mini-elon', name: '马斯克', spritesheetUrl: `${R2}/pets/mini-elon.webp`, tags: ['搞怪'] },
  { id: 'mini-sama', slug: 'mini-sama', name: '迷你大人', spritesheetUrl: `${R2}/pets/mini-sama.webp`, tags: ['搞怪'] },
  { id: 'moonlet', slug: 'moonlet', name: '小月亮', spritesheetUrl: `${R2}/pets/moonlet.webp`, tags: ['搞怪'] },
  { id: 'noctlet', slug: 'noctlet', name: '夜翼', spritesheetUrl: `${R2}/pets/noctlet.webp`, tags: ['搞怪'] },
  { id: 'orpheus', slug: 'orpheus', name: '俄耳甫斯', spritesheetUrl: `${R2}/pets/orpheus.webp`, tags: ['搞怪'] },
  { id: 'pedro-lapiz', slug: 'pedro-lapiz', name: '佩德罗', spritesheetUrl: `${R2}/pets/pedro-lapiz.webp`, tags: ['搞怪'] },
  { id: 'piggo-bike', slug: 'piggo-bike', name: '猪猪骑士', spritesheetUrl: `${R2}/pets/piggo-bike.webp`, tags: ['搞怪'] },
  { id: 'pixel', slug: 'pixel', name: '像素', spritesheetUrl: `${R2}/pets/pixel.webp`, tags: ['搞怪'] },
  { id: 'popeye', slug: 'popeye', name: '大力水手', spritesheetUrl: `${R2}/pets/popeye.webp`, tags: ['搞怪'] },
  { id: 'powerpet', slug: 'powerpet', name: '强力宠', spritesheetUrl: `${R2}/pets/powerpet.webp`, tags: ['搞怪'] },
  { id: 'raze-mini', slug: 'raze-mini', name: '小Raze', spritesheetUrl: `${R2}/pets/raze-mini.webp`, tags: ['搞怪'] },
  { id: 'red-white-gundam', slug: 'red-white-gundam', name: '红白高达', spritesheetUrl: `${R2}/pets/red-white-gundam.webp`, tags: ['搞怪'] },
  { id: 'robocop', slug: 'robocop', name: '机械战警', spritesheetUrl: `${R2}/pets/robocop.webp`, tags: ['搞怪'] },
  { id: 'rocky', slug: 'rocky', name: '洛基', spritesheetUrl: `${R2}/pets/rocky.webp`, tags: ['搞怪'] },
  { id: 'rocky-2', slug: 'rocky-2', name: '洛基 (2)', spritesheetUrl: `${R2}/pets/rocky-2.webp`, tags: ['搞怪'] },
  { id: 'sandworm-larva', slug: 'sandworm-larva', name: '沙虫幼虫', spritesheetUrl: `${R2}/pets/sandworm-larva.webp`, tags: ['搞怪'] },
  { id: 'scorpion', slug: 'scorpion', name: '蝎子', spritesheetUrl: `${R2}/pets/scorpion.webp`, tags: ['搞怪'] },
  { id: 'shoggoth', slug: 'shoggoth', name: '修格斯', spritesheetUrl: `${R2}/pets/shoggoth.webp`, tags: ['搞怪'] },
  { id: 'steve-jobs', slug: 'steve-jobs', name: '乔布斯', spritesheetUrl: `${R2}/pets/steve-jobs.webp`, tags: ['搞怪'] },
  { id: 'vault-boy', slug: 'vault-boy', name: '避难所小子', spritesheetUrl: `${R2}/pets/vault-boy.webp`, tags: ['搞怪'] },
  { id: 'wojak', slug: 'wojak', name: 'Wojak', spritesheetUrl: `${R2}/pets/wojak.webp`, tags: ['搞怪'] },

  // ── 可爱/治愈 ──
  { id: 'happy-brush', slug: 'happy-brush', name: '快乐画笔', spritesheetUrl: `${R2}/pets/happy-brush.webp`, tags: ['可爱'] },
  { id: 'azusa', slug: 'azusa', name: '梓', spritesheetUrl: `${R2}/pets/azusa.webp`, tags: ['可爱'] },
  { id: 'aoi-3', slug: 'aoi-3', name: '葵', spritesheetUrl: `${R2}/pets/aoi-3.webp`, tags: ['可爱'] },
  { id: 'bananacat', slug: 'bananacat', name: '香蕉猫', spritesheetUrl: `${R2}/pets/bananacat.webp`, tags: ['可爱'] },
  { id: 'omen-kitty-v3', slug: 'omen-kitty-v3', name: '暗影小猫', spritesheetUrl: `${R2}/pets/omen-kitty-v3.webp`, tags: ['可爱'] },

  // ── 科技/编程 ──
  { id: 'codie', slug: 'codie', name: 'Codie', spritesheetUrl: `${R2}/pets/codie.webp`, tags: ['编程'] },
  { id: 'cortana', slug: 'cortana', name: 'Cortana', spritesheetUrl: `${R2}/pets/cortana.webp`, tags: ['编程'] },
  { id: 'java', slug: 'java', name: 'Java', spritesheetUrl: `${R2}/pets/java.webp`, tags: ['编程'] },
  { id: 'macintosh', slug: 'macintosh', name: '麦金塔', spritesheetUrl: `${R2}/pets/macintosh.webp`, tags: ['编程'] },
  { id: 'tuxterm', slug: 'tuxterm', name: 'Linux企鹅', spritesheetUrl: `${R2}/pets/tuxterm.webp`, tags: ['编程'] },

  // ── 新增 ──
  { id: '77', slug: '77', name: '77', spritesheetUrl: `${R2}/pets/77.webp`, tags: ['动漫'] },
  { id: 'akaza', slug: 'akaza', name: '窝座', spritesheetUrl: `${R2}/pets/akaza.webp`, tags: ['动漫'] },
  { id: 'albedo-real-crisp', slug: 'albedo-real-crisp', name: '雅儿贝德', spritesheetUrl: `${R2}/pets/albedo-real-crisp.webp`, tags: ['动漫'] },
  { id: 'angemon', slug: 'angemon', name: '天使兽', spritesheetUrl: `${R2}/pets/angemon.webp`, tags: ['动漫'] },
  { id: 'aniya', slug: 'aniya', name: '阿尼亚', spritesheetUrl: `${R2}/pets/aniya.webp`, tags: ['动漫'] },
  { id: 'anon-3', slug: 'anon-3', name: '阿农', spritesheetUrl: `${R2}/pets/anon-3.webp`, tags: ['动漫'] },
  { id: 'baize', slug: 'baize', name: '白泽', spritesheetUrl: `${R2}/pets/baize.webp`, tags: ['动漫'] },
  { id: 'basketball-duck', slug: 'basketball-duck', name: '篮球鸭', spritesheetUrl: `${R2}/pets/basketball-duck.webp`, tags: ['动漫'] },
  { id: 'cash-cuy', slug: 'cash-cuy', name: '荷兰猪', spritesheetUrl: `${R2}/pets/cash-cuy.webp`, tags: ['动物'] },
  { id: 'christmas-zombie', slug: 'christmas-zombie', name: '圣诞僵尸', spritesheetUrl: `${R2}/pets/christmas-zombie.webp`, tags: ['搞怪'] },
  { id: 'mars-hei-mei-qiu', slug: 'mars-hei-mei-qiu', name: '火星黑煤球', spritesheetUrl: `${R2}/pets/mars-hei-mei-qiu.webp`, tags: ['搞怪'] },
  { id: 'shirobyte', slug: 'shirobyte', name: '白字节', spritesheetUrl: `${R2}/pets/shirobyte.webp`, tags: ['编程'] },
]

export const PET_TAGS = ['全部', '热门', '动漫', '动物', '搞怪', '可爱', '编程'] as const

export function getPetById(id: PetId): PetCatalogEntry | undefined {
  return PET_CATALOG.find(p => p.id === id)
}

export function getPetBySlug(slug: string): PetCatalogEntry | undefined {
  return PET_CATALOG.find(p => p.slug === slug)
}

export function getPetsByTag(tag: string): PetCatalogEntry[] {
  if (tag === '全部') return PET_CATALOG
  if (tag === '热门') {
    const hotIds = [
      'nezuko', 'luffy', 'luffy-2', 'frieren', 'chiikawa', 'kuromi', 'totoro',
      'keqing', 'gojo', 'naruto', 'itachi', 'zoro', 'shinobu', 'kyojuro-rengoku',
      'duck-jiji', 'rock-kingdom-daeermaodou', 'xueying-wawa', 'miaomiao-codex',
      'chonk', 'mochi', 'pepe', 'golden-retriever', 'pixel-panda', 'cache-capy',
      'buff-patrick', 'clippy', 'einstein', 'vault-boy', 'steve-jobs',
      'happy-brush', 'cinnamonroll', 'teddy',
      'tuxterm', 'java', 'codie',
    ]
    return PET_CATALOG.filter(p => hotIds.includes(p.id))
  }
  return PET_CATALOG.filter(p => p.tags.includes(tag))
}
