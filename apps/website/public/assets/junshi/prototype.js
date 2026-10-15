/* 招生军师 · 内部预览 —— 原型脚本（见同目录 ../../junshi/index.html 顶部注释）*/
(function(){
  var root=document.getElementById('js-app');
  if(!root) return;
  var $=function(s){return root.querySelector(s)};
  var $$=function(s){return Array.prototype.slice.call(root.querySelectorAll(s))};

  /* ---------- nav ---------- */
  function show(name){
    $$('.js-screen').forEach(function(s){s.hidden=(s.id!=='scr-'+name)});
    $$('.js-navitem').forEach(function(b){
      if(b.dataset.screen===name){b.setAttribute('aria-current','true')}else{b.removeAttribute('aria-current')}
    });
    state.screen=name; save();
  }
  $$('.js-navitem').forEach(function(b){b.addEventListener('click',function(){show(b.dataset.screen)})});

  /* ---------- state ---------- */
  var state={screen:'war',month:10,hook:null,done:[],q:''};
  try{
    var sv=window.zcode&&window.zcode.widgetState;
    if(sv&&typeof sv==='object'){if(sv.screen)state.screen=sv.screen;if(sv.month)state.month=sv.month;if(sv.hook)state.hook=sv.hook;if(sv.q)state.q=sv.q}
  }catch(e){}
  function save(){
    try{
      if(window.zcode&&window.zcode.setWidgetState){
        window.zcode.setWidgetState({modelContent:{screen:state.screen,month:state.month,hook:state.hook,q:state.q},privateContent:{done:state.done}}).catch(function(){});
      }
    }catch(e){}
  }

  /* ---------- 作战台：全年日历 ---------- */
  var CAL={
    1:['寒假班 · 显眼包计划','新年消课 · 寒假集训营','春招续费启动','元旦地推 · 新春纳福','年前的资源储备决定了开年春季招生季的邀约力度。这个月最忌讳的就是『躺平』和『懒』。'],
    2:['新春开学季 · 虎宝闹元宵','—','常规老生续费','新年红包维护裂变','2 月是开学季招生第 1 个关键时间，最忌讳的就是『慢』和『被动』。'],
    3:['春季招生嘉年华','植树节公益课','—','转介绍月 · 3·8 女神节','转介绍活动想要做成功的关键：成果可视化。'],
    4:['常态化地推 · 路演','红旗下的我们','—','愚人节 · 地球日','本月重点依然是资源储备，关键就是『走出去』。'],
    5:['疯狂5月Fun肆宠粉','劳动节集训营','淡季老会员续课','母亲节 · 异业合作','本月是洽谈渠道合作最好的时候，重点是点对点合作，不建议所谓的异业联盟活动。'],
    6:['儿童节 · 61暑惠卡','父亲节消课 · 端午','618 年中钜惠','亲子童学 · 成果展示','我们与市场竞争的核心资源最终都是学生的时间，一定要抢占先机。'],
    7:['暑期抢跑计划','暑期班课消','—','暑期盛典 · 家校表演课','招生和课消的狂欢，这个月要把业绩和课消推向新的水平。'],
    8:['暑期集训营 · 标杆计划','组织等级考试','—','秋招蓄水 · 意向客户群','需要进一步储备力量赢战 9 月份开学季。'],
    9:['开学季 · 秋招资料包','中秋亲子赏月','涨价前集中续费','教师节 · 成果展示','9 月份直接决定下半年学员基数和课消水平。'],
    10:['秋季招生 · 万圣节','国庆消课 · 爱享计划','老生常规续费','转介绍组合拳','开学季 + 转介绍活动，这是一套组合拳。'],
    11:['双11go狂欢 · 定金拉新','双11 课包换购','续费销售重点月','感恩节引爆寒假招生','十一月份重点做好续费销售工作。'],
    12:['双12 · 寒假班招募','新年消课 · 精灵圣诞夜','年终钜惠涨价倒计时','双旦加个蛋 · 年终晚会','12 月份是双十一的延续，也是寒假的前期。']
  };
  var MONTHS=['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
  var MSHORT=['寒假班','开学季','转介绍','地推','母亲节','暑招','暑期课消','秋招储备','开学季','本月','双11','双12'];
  var mBox=$('#js-months'),mDetail=$('#js-mdetail');
  function renderMonths(){
    mBox.innerHTML='';
    MONTHS.forEach(function(m,i){
      var n=i+1,b=document.createElement('button');
      b.type='button';b.className='js-month';b.dataset.m=n;
      b.setAttribute('aria-pressed',String(state.month===n));
      b.innerHTML='<b>'+m+'</b><u>'+MSHORT[i]+'</u>';
      b.addEventListener('click',function(){state.month=n;renderMonths();save()});
      mBox.appendChild(b);
    });
    var c=CAL[state.month];
    mDetail.innerHTML='<div class="js-mline"><b>'+state.month+'月 · 拉新</b><span>'+c[0]+'</span></div>'+
      '<div class="js-mline"><b>课消</b><span>'+c[1]+'</span></div>'+
      '<div class="js-mline"><b>续费</b><span>'+c[2]+'</span></div>'+
      '<div class="js-mline"><b>转介绍</b><span>'+c[3]+'</span></div>'+
      '<div class="js-mnote">军师提醒：'+c[4]+'</div>';
  }
  renderMonths();

  /* ---------- 作战台：待办 ---------- */
  $$('[data-todo]').forEach(function(t){
    t.addEventListener('click',function(){
      var box=t.querySelector('.js-box');
      box.classList.toggle('on');
    });
  });

  /* ---------- 策划室 ---------- */
  var HOOKS=[
    {id:'A',name:'萌鬼巡游 · 讨糖地图',pt:'到店领「讨糖地图」，3 个校区集章换礼包',cost:'约 ¥1,200',power:'强（必须结伴才能集齐）',entry:'现场报寒假集训营立减',risk:'人流大，需控场'},
    {id:'B',name:'亲子妆容 DIY · 打卡集赞',pt:'家长给孩子化万圣妆 → 拍照 → 集赞换礼',cost:'约 ¥2,600',power:'强（UGC 自发传播）',entry:'体验课 → 正课转化',risk:'需摄影 + 素材审核'},
    {id:'C',name:'1 元鬼马盲盒',pt:'1 元抽盲盒，内藏课时券；老带新双人成行',cost:'约 ¥3,800',power:'最强（双人成行机制）',entry:'盲盒内嵌 200 元课时券',risk:'抽奖合规需确认'}
  ];
  var hookBox=$('#js-hooks');
  function renderHooks(){
    hookBox.innerHTML='';
    HOOKS.forEach(function(h){
      var b=document.createElement('button');
      b.type='button';b.className='js-hook';
      b.setAttribute('aria-pressed',String(state.hook===h.id));
      b.innerHTML='<b>方案 '+h.id+'：'+h.name+'</b><dl>'+
        '<dt>玩法 </dt><dd>'+h.pt+'</dd><br>'+
        '<dt>成本 </dt><dd>'+h.cost+'</dd><br>'+
        '<dt>老带新 </dt><dd>'+h.power+'</dd><br>'+
        '<dt>转化口 </dt><dd>'+h.entry+'</dd><br>'+
        '<dt>风险 </dt><dd>'+h.risk+'</dd></dl>';
      b.addEventListener('click',function(){
        state.hook=h.id;renderHooks();
        var w=$('#js-outwrap');w.hidden=false;
        $('#js-outtitle').textContent='方案 '+h.id+'「'+h.name+'」';
        save();
      });
      hookBox.appendChild(b);
    });
    if(state.hook){
      $('#js-outwrap').hidden=false;
      var f=HOOKS.filter(function(x){return x.id===state.hook})[0];
      if(f)$('#js-outtitle').textContent='方案 '+f.id+'「'+f.name+'」';
    }
  }
  renderHooks();

  /* ---------- 话术陪练 ---------- */
  var CHAIN={
    '太贵了':[
      ['共情','理解您，教育支出确实要算一算，谁家的钱都不是大风刮来的。'],
      ['重塑','算下来一个月才 1000 元——您少去吃两顿大餐、少抽几包烟、少买一件衣服，就出来了。'],
      ['证据','咱们老师 70% 以上都是 985/211 或研究生学历；这是每个阶段的课评和孩子的成长档案，您可以翻。'],
      ['降险','您要后期没时间，再找我，我把钱退给您。'],
      ['稀缺','这个价只限前 10 个名额，报满了就不能报了。']
    ],
    '孩子太小了':[
      ['共情','您这个顾虑特别正常，很多家长一开始都这么想。'],
      ['重塑','小年龄段其实是最关键的敏感期，学的是规则感和专注力，不是技法。'],
      ['证据','这是我们同龄班孩子的课评和成长档案，您可以看看三个月的变化。'],
      ['降险','您先带孩子来上一节，不合适我绝不劝您。'],
      ['稀缺','这个班型目前只剩 3 个位置。']
    ],
    '没时间 / 周末排满了':[
      ['共情','我理解，现在孩子的周末比大人还忙。'],
      ['重塑','我们的课周三到周日全天都有，按您的时间挑，而且 19.9 的课包没有时间限制。'],
      ['证据','这是我们的排课表，您看哪个时段合适。'],
      ['降险','先来体验一节，时间不合适随时调整。'],
      ['稀缺','黄金时段（周六上午）只剩 2 个名额了。']
    ],
    '要回去和孩子爸爸商量':[
      ['共情','您尊重孩子爸爸的意见，这点我特别认同。'],
      ['重塑','但孩子上课这事最怕拖——这周定下来，孩子这周就能开始。'],
      ['证据','我把课程方案、课时安排、费用明细整理成一份发给您，方便您和爸爸一起看。'],
      ['降险','今天的活动价我先帮您保留到明天。'],
      ['稀缺','名额只剩几个，超过就恢复原价了。']
    ],
    '已经在别家报了':[
      ['共情','挺好的，说明您对孩子教育很上心。'],
      ['重塑','不冲突的——我们上课时间可以错开，教材和教学风格也不一样，正好互补。'],
      ['证据','有个孩子王××去别的地方学了一段时间没学到东西，现在又回来我们这边。'],
      ['降险','您可以先来上一节对比一下，孩子自己会选。'],
      ['稀缺','体验课包这个价这周截止。']
    ],
    '我回去看看 / 下次再说':[
      ['共情','好的，您先忙。'],
      ['重塑','不过孩子这件事，拖着拖着就是一个学期。'],
      ['证据','这是我们在读学员家长的评价，您可以看看。'],
      ['降险','19.9 的课包没有时间限制，您什么时候方便什么时候来。'],
      ['稀缺','我今天先帮您占个名额——19.9 直接转给我就行。']
    ]
  };
  var chipBox=$('#js-chips'),chainBox=$('#js-chain');
  var curObj='太贵了';
  function renderChips(){
    chipBox.innerHTML='';
    Object.keys(CHAIN).forEach(function(k){
      var b=document.createElement('button');
      b.type='button';b.className='js-chip';b.textContent=k;
      b.setAttribute('aria-pressed',String(k===curObj));
      b.addEventListener('click',function(){curObj=k;renderChips()});
      chipBox.appendChild(b);
    });
    var arr=CHAIN[curObj];
    chainBox.innerHTML=arr.map(function(s,i){
      return '<div class="js-step"><span class="js-stepno">'+(i+1)+'</span><div><b>'+s[0]+'</b><p>'+s[1]+'</p></div></div>';
    }).join('');
  }
  renderChips();
  $$('.js-scene').forEach(function(s){
    s.addEventListener('click',function(){
      $$('.js-scene').forEach(function(x){x.setAttribute('aria-pressed','false')});
      s.setAttribute('aria-pressed','true');
    });
  });

  /* ---------- 转化教练 ---------- */
  var STEPS=[
    ['课前小会','介绍客户信息 → 制定解决方案 → 分配角色 → 准备销售工具','5 min'],
    ['接待','上前迎接、引座、倒水，第一印象分','5 min'],
    ['参观校区','边走边讲，把环境变成教学证据','20 min'],
    ['介绍老师','名师墙 + 学历资历，建立专业信任','5 min'],
    ['DEMO 课','孩子在课堂，家长在外面感受到热闹','60–90 min'],
    ['群咨 + 一对一咨询','挖掘问题 · 订制课程 · 传达优惠（报 2 期 95 折 / 报 3 期 92 折 / 转介绍一名新生赠一节课）','30 min 起'],
    ['课程反馈','老师用专业词汇解析作品，让孩子跟家长说喜欢你；招生专员协助逼单','20 min'],
    ['报名','先刷卡，再录入系统','15 min'],
    ['送孩子','送到门口，约定下次','5 min'],
    ['总结会','当天复盘：哪一步丢了、哪句话有效','15 min 起']
  ];
  var checkBox=$('#js-checks');
  checkBox.innerHTML=STEPS.map(function(s,i){
    return '<button class="js-check" type="button" data-step="'+i+'"><span class="js-box"><i data-lucide="check" aria-hidden="true"></i></span><span><b>'+s[0]+'</b><p>'+s[1]+'</p></span><span class="js-min">'+s[2]+'</span></button>';
  }).join('');
  function renderChecks(){
    var n=state.done.length;
    $$('[data-step]').forEach(function(el){
      var i=+el.dataset.step,on=state.done.indexOf(i)>=0;
      el.querySelector('.js-box').classList.toggle('on',on);
      el.querySelector('span:nth-child(2)').className=on?'done':'';
    });
    var pct=Math.round(n/STEPS.length*100);
    $('#js-checkbar').firstElementChild.style.width=pct+'%';
    $('#js-checktext').textContent='已完成 '+n+' / '+STEPS.length+' 步 · 得分 '+(n*10)+' 分'+(n>=9?'（A 类，可直接进入逼单）':n>=7?'（B 类，注意补漏）':'');
  }
  $$('[data-step]').forEach(function(el){
    el.addEventListener('click',function(){
      var i=+el.dataset.step,k=state.done.indexOf(i);
      if(k>=0){state.done.splice(k,1)}else{state.done.push(i)}
      renderChecks();save();
    });
  });
  renderChecks();

  /* ---------- 团队：奖金池 ---------- */
  var range=$('#js-range');
  function renderPool(){
    var v=+range.value,over=Math.max(0,v-110),pool=over*0.1;
    $('#js-perf').textContent=v;
    $('#js-pool').textContent=pool.toFixed(1)+' 万';
    $('#js-p1').textContent=(pool*0.2).toFixed(2)+' 万';
    $('#js-p2').textContent=(pool*0.1).toFixed(2)+' 万';
    $('#js-p3').textContent=(pool*0.7).toFixed(2)+' 万';
  }
  range.addEventListener('input',renderPool);
  renderPool();

  /* ---------- 素材库 ---------- */
  var DOCS=[
    {n:'【虎宝闹元宵·好礼迎开学】元宵招生方案（共 7 份资料）',c:'04-节假日',t:'节日方案',k:['元宵','节日']},
    {n:'中秋亲子赏月活动资料包（8 份资料）',c:'04-节假日',t:'节日方案',k:['中秋','节日']},
    {n:'【时空穿梭·亲子童学】儿童节招生方案（共 5 份资料）',c:'04-节假日',t:'节日方案',k:['儿童节','节日']},
    {n:'「时光献礼·表白妈妈」母亲节招生方案（共 8 份资料）',c:'04-节假日',t:'节日方案',k:['母亲节','节日']},
    {n:'万圣节活动 · 消课活动方案',c:'03-全年活动方案',t:'活动包',k:['万圣节','节日','课消']},
    {n:'万圣节 Party 会员活动（含布置清单与预算）',c:'03-全年活动方案',t:'活动包',k:['万圣节','节日']},
    {n:'万圣节活动设计源文件包（海报 / 展架 / 门贴 PSD）',c:'03-全年活动方案',t:'物料',k:['万圣节','物料']},
    {n:'万圣节朋友圈 + 群消息文案',c:'11-朋友圈文案',t:'文案',k:['万圣节','朋友圈']},
    {n:'众筹压岁钱 招生法（规则图 + 讲解视频）',c:'12-78套招生法',t:'招生法',k:['春节','裂变','老带新']},
    {n:'家长定价 招生法（学费多少你来定）',c:'12-78套招生法',t:'招生法',k:['定价','老带新']},
    {n:'100元6节课 招生法',c:'12-78套招生法',t:'招生法',k:['低价引流','老带新']},
    {n:'老带新拼团活动方案（3 人成团 · 团长免单）',c:'03-全年活动方案',t:'活动包',k:['老带新','拼团']},
    {n:'地推宝典 · 17 份话术 + 12 份手册',c:'05-地推招生方案',t:'话术',k:['地推','话术','太贵了']},
    {n:'地推 5 次拒绝话术（递进式异议处理）',c:'05-地推招生方案',t:'话术',k:['地推','话术','太贵了']},
    {n:'续费话术 · 异议处理篇（5 大类 + 8 条非常规）',c:'08-续班招生方案',t:'话术',k:['续费','话术','太贵了']},
    {n:'教育行业快闪转化社群 SOP（7 天五阶段）',c:'07-微信私域',t:'SOP',k:['社群','裂变']},
    {n:'试听课标准流程（10 步 · 带分钟数与评分）',c:'10-试听课',t:'SOP',k:['试听','转化']},
    {n:'续班率的核算方法及奖罚（含公式与金额）',c:'08-续班招生方案',t:'制度',k:['续费','考核']},
    {n:'家长会续班流程 + 主持稿 + 配乐',c:'10-试听课',t:'SOP',k:['家长会','续费']},
    {n:'双11 朋友圈营销四步曲（预热/见证/现场/逼单）',c:'01-全年招生方案',t:'内容日历',k:['朋友圈','双十一']},
    {n:'招生朋友圈纯文案（155 条）',c:'11-朋友圈文案',t:'文案',k:['朋友圈']},
    {n:'秋季招生方案 · 1 元生存挑战赛',c:'02-全年招生方案',t:'活动包',k:['秋季','老带新']},
    {n:'家长合伙人模式（消费型 / 资源型 / 投资型）',c:'06-家长合伙人',t:'制度',k:['老带新','制度']}
  ];
  var CHIPS=['全部','节日方案','招生法','活动包','话术','SOP','内容日历','文案','物料','制度'];
  var libChips=$('#js-libchips'),libBox=$('#js-lib'),qInput=$('#js-q'),countEl=$('#js-count');
  var libFilter='全部',libSel=-1;
  function renderChipsLib(){
    libChips.innerHTML='';
    CHIPS.forEach(function(c){
      var b=document.createElement('button');
      b.type='button';b.className='js-chip';b.textContent=c;
      b.setAttribute('aria-pressed',String(c===libFilter));
      b.addEventListener('click',function(){libFilter=c;renderChipsLib();renderLib()});
      libChips.appendChild(b);
    });
  }
  function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;')}
  function renderLib(){
    var q=(qInput.value||'').trim();
    var list=DOCS.filter(function(d){
      if(libFilter!=='全部'&&d.t!==libFilter)return false;
      if(!q)return true;
      return (d.n+d.c+d.t+d.k.join(' ')).indexOf(q)>=0;
    });
    countEl.textContent=list.length+' / '+DOCS.length+' 条（全库 8994 个文件）';
    libBox.innerHTML='';
    if(!list.length){
      libBox.innerHTML='<p style="font-size:12px;color:var(--p-text3)">没有匹配。全库里这类内容可能只有图片物料（78 套招生法大多是 mp4 + 海报）。</p>';
      return;
    }
    list.forEach(function(d){
      var idx=DOCS.indexOf(d);
      var b=document.createElement('button');
      b.type='button';b.className='js-doc';
      b.setAttribute('aria-expanded',String(libSel===idx));
      if(libSel===idx)b.style.borderColor='var(--p-brand)';
      var name=esc(d.n);
      if(q)name=name.split(esc(q)).join('<span class="js-hit">'+esc(q)+'</span>');
      b.innerHTML='<span class="js-tag">'+d.t+'</span><b>'+name+'</b><em>'+d.c+'</em>';
      b.addEventListener('click',function(){
        libSel=(libSel===idx?-1:idx);renderLib();
      });
      libBox.appendChild(b);
      if(libSel===idx){
        var det=document.createElement('div');
        det.className='js-libdetail';
        det.innerHTML='<b style="font-weight:500;color:var(--p-text)">这套资料里有：</b>执行案 · 物料清单（含采购链接）· 前期软文 · 各环节话术 · 激励方案 · 报名表 · 签到表 · 设计源文件（PSD）'+
          '<div class="js-practice" style="border-top:0;padding-top:9px;margin-top:4px">'+
          '<button class="js-btn primary" type="button"><i data-lucide="sparkles" style="width:12px;height:12px;vertical-align:-2px" aria-hidden="true"></i> 改编为本机构版本</button>'+
          '<span style="font-size:11.5px;color:var(--p-text3)">将替换 27 处品牌 / 价格 / 地址，并自动处理 4 处极限词</span></div>';
        libBox.appendChild(det);
      }
    });
    if(window.lucide&&window.lucide.createIcons){window.lucide.createIcons()}
  }
  qInput.value=state.q||'';
  qInput.addEventListener('input',function(){state.q=qInput.value;renderLib();save()});
  renderChipsLib();renderLib();

  /* ---------- 机构画像 ---------- */
  var PG={
    base:{t:'基本信息',f:[['机构名称','星艺少儿美术'],['简称','星艺美术'],['成立年份','2019'],['城市','本市'],['校区数量','3 个（城东 / 城西 / 城南）']]},
    product:{t:'产品体系',f:[['课程品类','少儿美术 / 书法 / 素描'],['班型','6 人小班 · 1 对 1'],['课时单价','¥120'],['主力课包','半年 24 节 ¥2,880 · 全年 48 节 ¥5,280'],['优惠底线','不低于 8.5 折']]},
    teacher:{t:'师资信息',f:[['教师人数','14 人'],['学历构成','本科 11 人 · 硕士 3 人'],['教龄构成','3 年以上 9 人'],['明星教师','孟坤老师 · 8 年教龄 · 带出获奖学员 32 人']]},
    biz:{t:'经营数据',f:[['在读学员','386 人'],['分校区人数','城东 168 · 城西 142 · 城南 76'],['满班率','82%'],['历史续班率','86%']]},
    reach:{t:'触达方式',miss:1,f:[['企业微信活码',''],['公众号','星艺少儿美术'],['抖音号',''],['联系电话',''],['校区地址话术','城东（万象汇）城西（银泰城、万达）']]},
    case:{t:'案例素材',f:[['学员案例','王×× 从零基础到市级比赛三等奖（8 个月）'],['家长好评','“孩子现在自己主动画画了”'],['成果数据','2026 年市级少儿美术大赛获奖 12 人']]},
    risk:{t:'合规红线',miss:1,f:[['不能说的词',''],['不能承诺的事',''],['预收费规则','']]}
  };
  var pgCur='base', orgName='星艺少儿美术';
  var pgBox=$('#js-pgroups'), pgFields=$('#js-pgfields');
  function renderPgGroups(){
    pgBox.innerHTML='';
    Object.keys(PG).forEach(function(k){
      var g=PG[k],b=document.createElement('button');
      b.type='button';b.className='js-scene';b.setAttribute('aria-pressed',String(k===pgCur));
      b.innerHTML=g.t+'<span'+(g.miss?'':' style="color:var(--p-green)"')+'>'+(g.miss?'待补充':'已完成')+'</span>';
      b.addEventListener('click',function(){pgCur=k;renderPgGroups();renderPgFields()});
      pgBox.appendChild(b);
    });
  }
  function renderPgFields(){
    var g=PG[pgCur];
    $('#js-pgtitle').textContent=g.t+(g.miss?' · 待补充':'');
    pgFields.innerHTML='';
    g.f.forEach(function(f,i){
      var row=document.createElement('div');row.className='js-field';
      var id='pgf_'+pgCur+'_'+i;
      var lab=document.createElement('label');lab.setAttribute('for',id);lab.textContent=f[0];
      var inp=document.createElement('input');inp.id=id;inp.type='text';inp.value=f[1]||'';
      if(!f[1])inp.placeholder='待补充';
      if(pgCur==='base'&&i===0){
        inp.addEventListener('input',function(){orgName=inp.value;renderDiff()});
      }
      row.appendChild(lab);row.appendChild(inp);pgFields.appendChild(row);
    });
  }
  function renderDiff(){
    var n=orgName||'（你的机构名）';
    $('#js-diffout').innerHTML='家长您好！打扰您一下，我是<span class="js-hl ok">'+esc(n)+'</span>的老师，我们现在有一个 <span class="js-hl ok">19.9</span> 试听课包的活动，一节精品课程，还有小礼品赠送给您……我们在<span class="js-hl ok">城东（万象汇）城西（银泰城、万达）</span>都有校区，目前也是<span class="js-hl ok">规模领先的</span>美术教育机构，老师 <span class="js-hl ok">70% 以上是 985/211 或研究生学历</span>。';
  }
  $('#js-difforg').innerHTML='家长您好！打扰您一下，我是<span class="js-hl">蓝色金</span>美术的老师，我们现在有一个 19.9 试听课包的活动，一节精品课程，还有小礼品赠送给您……我们在<span class="js-hl">莱山（福地隆城）芝罘（大成门、西海岸）</span>都有校区，目前也是<span class="js-hl">烟台最大的</span>美术教育机构，老师 70% 以上都是 985、211 或者研究生学历。';
  renderPgGroups();renderPgFields();renderDiff();

  /* ---------- 内容工厂 ---------- */
  var PAT=[
    {k:'焦虑递进',c:'你来，我培养你的孩子\n你不来，我培养你孩子未来的竞争对手\n反正我们不能闲着…',src:'11-朋友圈招生文案（19 条）',ok:'合规检查：通过（无极限词）'},
    {k:'时令论',c:'小学嫌早，初中嫌贵，高中嫌晚，这是认知局限\n春天播种，夏天耕耘，秋天收获\n不误时令方有收获，背道而驰难有成果~',src:'11-朋友圈招生文案（19 条）',ok:'合规检查：通过（无极限词）'},
    {k:'价格换算',c:'不是报辅导班太贵，而是在您眼里，没给辅导留地位！\n①吃顿饭 300，不贵！就管 6 小时\n②说到报辅导班时，哇，太贵了……但它却保孩子一辈子',src:'11-朋友圈招生文案（19 条）',ok:'合规检查：通过（“太贵了”为家长原话引用，不构成承诺）'},
    {k:'反鸡娃',c:'废掉一个孩子最好的方式——就是让他按自己喜欢的方式长大\n不想学习就不学了，不想上课就别上了\n结果就成了孩子啥也没学会\n强者谈坚持！弱者谈喜欢！！！',src:'11-朋友圈招生文案（19 条）',ok:'合规检查：1 处待处理 —— 本句含极限词「最好」。建议改成「废掉一个孩子，就是让他按自己喜欢的方式长大」——删掉「最好的」，句子反而更狠。'},
    {k:'弯道超车',c:'自己在休息的时候，别忘了别人还在奔跑\n别人在弯道超车的时候，你千万不要减速 ⚠',src:'11-朋友圈招生文案（49 条）',ok:'合规检查：通过'},
    {k:'延迟效应',c:'教育是有延迟性的\n半年后，你会发现当初你交的学费并没有对你的生活造成任何影响！\n三年后，你会发现你所得到的开始影响孩子的人生！',src:'11-朋友圈招生文案（49 条）',ok:'合规检查：1 处提示 —— “你会发现”属主观断言，建议加“很多家长反馈”作限定'},
    {k:'九字对照',c:'你用 9 个字，拒绝了成绩提升\n①学费高 ②没时间 ③考虑下\n学校用 9 个字，拒绝给你求学机会\n①分不够 ②等回复 ③没办法',src:'11-朋友圈招生文案（56 条）',ok:'合规检查：通过'},
    {k:'人设自嘲',c:'做教育就像谈恋爱，总联系吧，怕对方烦\n不联系吧，又怕被人横刀夺爱\n一天到晚心里装的都是我的家长\n我太难了',src:'12.招生朋友圈纯文案（155 条）',ok:'合规检查：通过'}
  ];
  var patCur=0, chanCur='朋友圈';
  var cChips=$('#js-cchips'), cCard=$('#js-copycard'), cMeta=$('#js-copymeta'), cCom=$('#js-comcheck');
  function renderPatChips(){
    cChips.innerHTML='';
    PAT.forEach(function(p,i){
      var b=document.createElement('button');
      b.type='button';b.className='js-chip';b.textContent=p.k;
      b.setAttribute('aria-pressed',String(i===patCur));
      b.addEventListener('click',function(){patCur=i;renderPatChips();renderCopy()});
      cChips.appendChild(b);
    });
  }
  function renderCopy(){
    var p=PAT[patCur], body=p.c, first=p.c.split('\n')[0];
    var out;
    if(chanCur==='朋友圈'){out=body+'\n\n#星艺少儿美术 #少儿美术 #孩子学画画';}
    else if(chanCur==='班级群'){out='【今日分享】\n'+body+'\n\n家长们有什么想法，欢迎在群里聊聊～';}
    else if(chanCur==='一对一私信'){out='家长您好，看到一句话想分享给您：\n\n'+body+'\n\n（我是星艺少儿美术的孟老师）';}
    else if(chanCur==='小红书'){out='标题：教培老师的一段大实话\n\n'+body+'\n\n#少儿美术 #育儿 #美术培训 #家长必看';}
    else {out='【口播脚本 · 约 25 秒】\n[镜头：老师正面特写，背景是教室]\n\n「'+first.replace(/[！!。，、…]/g,'，')+'」\n\n[字幕跟上，配轻快 BGM]\n\n（结尾口播：关注我，每天一条教培真话）';}
    cCard.textContent=out;
    cMeta.innerHTML='<span>套路：'+p.k+'</span><span>来源：'+p.src+'</span><span>形态：'+chanCur+'</span>';
    cCom.textContent=p.ok;
    cCom.style.color=p.ok.indexOf('通过')>0?'var(--p-text3)':'var(--p-warm)';
  }
  $$('[data-chan]').forEach(function(b){
    b.addEventListener('click',function(){
      chanCur=b.dataset.chan;
      $$('[data-chan]').forEach(function(x){x.setAttribute('aria-pressed',String(x===b))});
      renderCopy();
    });
  });
  var SCHEDULE=[
    ['8:00–10:00','心灵鸡汤 + 朋友圈点赞 10 分钟（5–10 个客户，能评论的尽量评论）'],
    ['10:00–11:00','产品知识与好评'],
    ['12:00–13:00','个人生活（朋友圈点赞最少 20 个，走心留言 10 条）'],
    ['15:00–16:00','互动话题 · 抽奖（福利产品 1 周 1 次，最少 2 周 1 次）'],
    ['17:00–18:00','工作日常'],
    ['20:00–22:00','好评 + 与好友私聊互动 5 个']
  ];
  $('#js-schedule').innerHTML=SCHEDULE.map(function(s){
    return '<div class="js-slot"><b>'+s[0]+'</b><span>'+s[1]+'</span></div>';
  }).join('');
  var WEEK=[['周一','秒杀活动 · 裂变'],['周二','建立 IP · 输出价值'],['周三','输出价值'],['周四','客户见证'],['周五','互动话题 · 茶话会'],['周六','学习资料分享'],['周日','生活日常']];
  $('#js-week').innerHTML=WEEK.map(function(w){
    return '<div class="js-slot"><b>'+w[0]+'</b><span>'+w[1]+'</span></div>';
  }).join('');
  renderPatChips();renderCopy();

  /* ---------- init ---------- */
  show(state.screen);
  if(window.lucide&&window.lucide.createIcons){window.lucide.createIcons()}
})();
