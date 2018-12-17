let BigNumber = require('bignumber.js').default;

let Czr = require("../czr/index");
let czr = new Czr();
let profiler = require("./profiler");

let pgclient = require('./PG');// 引用上述文件
pgclient.getConnection();

//写日志
let log4js = require('./log_config');
let logger = log4js.getLogger('write_db');//此处使用category的值
let self; 
const WITNESS_ARY=[
    "czr_321JDA7Brgbnm64iY2Xh8yHMEqEgBDutnoTKVLcxW2DJvJLUsS",
    "czr_32RmC9FsxjgLkgRQ58j3CdLg79cQE3KaY2wAT1QthBTU25vpd3",
    "czr_3MnXfV9hbmxVPdgfrPqgUiH6N7VbkSEhn5VqBCzBcxzTzkEUxU",
    "czr_3SrfL6LnPbtyf6sanrgtKs1BTYDN8taacGBVG37LfZVqXvRHbf",
    "czr_3igvJpdDiV4v5HxEzCifFcUpKvWsk3qWYNrTrbEVQztKbpyW1z",
    "czr_3tiy2jgoUENkszPjrHjQGfmopqwV5m9BcEh2Grb1zDYgSGnBF7",
    "czr_47E2jJ9rXVk5GRBcTLQMLQHXqsrnVcV5Kv2CWQJ6dnUaugnvii",
    "czr_4HhYojuHanxQ57thkSxwy5necRtDFwiQP7zqngBDZHMjqdPiMS",
    "czr_4MYTD6Xctkb6fEL8xUZxUwY6eqYB7ReEfB61YFrMHaZxsqLCKd",
    "czr_4URkteqck9rM8Vo6VzWmvKtMWoSH8vo4A1rADNAFrQHxAR23Tb",
    "czr_4ZJ8hBdR6dLv4hb1RPCmajdZf7ozkH1sHU18kT7xnXj4mjxxKE",
    "czr_4iig3fTcXQmz7bT2ztJPrpH8usrqGTN5zmygFqsCJQ4HgiuNvP"
];

//辅助数据 Start
let getRpcTimer = null,
    getUnstableTimer = null;
let dbStableMci,        //本地数据库的最高稳定MCI
    rpcStableMci;       //RPC接口请求到的最高稳定MCI
// let cartStep = 0;       //如果数据过多时候，每批处理地数据，0是每次获取一个 ====> 需求改了，数据过大，不能一次插入多个MCI下的blocks 
let isStableDone = false;//稳定的MCI是否插入完成
//辅助数据 End

// 操作稳定Unit相关变量 Start
let next_index          = '';
let MCI_LIMIT           = 10;
let unitInsertAry       = [];//不存在unit,插入[Db]
let unitUpdateAry       = [];//存在的unit,更新[Db]
let accountsInsertAry   = [];//不存在的账户,插入[Db]
let accountsUpdateAry   = [];//存在的账户,更新[Db]
let parentsTotalAry     = [];//储存预处理的parents信息[Db]
let witnessTotal        = {};//储存预处理的见证人信息[Db]

let accountsTotal   = {};//储存预处理的账户信息
let unitAryForSql   = [];//作为语句，从数据库搜索已有unit

let timestampTotal  = {};//储存预处理的时间戳信息
let timestampInsertAry   = [];//没有的timestamp,插入[Db]
let timestampUpdateAry   = [];//存在的timestamp,更新[Db]

let timestamp10Total  = {};//储存预处理的时间戳信息
let timestamp10InsertAry   = [];//没有的timestamp,插入[Db]
let timestamp10UpdateAry   = [];//存在的timestamp,更新[Db]
// 操作稳定Unit相关变量 End

// 批量操作不稳定Unit相关变量 Start
let unstable_next_index     = '';
let unstableUnitHashAry     = [];//不稳定Unit Hash组成的数组
let unstableParentsAry      = [];//需要插入的Parents
let unstableWitnessTotal    = {};//需要预处理的Witness
let unstableInsertBlockAry  = [];//需要插入的Block
let unstableUpdateBlockAry  = [];//需要更新的Block
// 批量操作不稳定Unit相关变量 End


let pageUtility = {
    init() {
        self =this;
        let SearchOptions = {
            text: "select mci from transaction where (is_stable = $1) order by pkid desc limit 1",
            values: [true]
        };
        pgclient.query(SearchOptions, (data) => {
            if (data.length === 0) {
                dbStableMci = 0;
            } else if (data.length === 1) {
                dbStableMci = Number(data[0].mci) + 1;
            } else if (data.length > 1) {
                logger.info("get dataCurrentMai is Error");
                return;
            }
            logger.info(`当前数据库稳定MCI : ${dbStableMci-1} ， 需要拿 ${dbStableMci} 去获取最新数据`);
            pageUtility.readyGetData();
        });
    },
    readyGetData() {
        getRpcTimer = setTimeout(function () {
            pageUtility.getRPC()
        }, 1000)
    },
    getRPC() {
        //获取网络中最新稳定的MCI
        logger.info(`获取网络中最新稳定的MCI-Start`);
        czr.request.status().then(function (status) {
            logger.info(`获取网络中最新稳定的MCI-Success `);
            logger.info(status);
            return status
        }).catch((err)=>{
            logger.info(`获取网络中最新稳定的MCI-Error : ${err}`);
        })
        .then(function (status) {
            rpcStableMci = Number(status.status.last_stable_mci);
            if ((dbStableMci <= rpcStableMci) || (dbStableMci ===0)) {
                isStableDone = dbStableMci < rpcStableMci ? false : true;
                pageUtility.searchMci(status.status);
            } else {
                getUnstableTimer = setTimeout(function () {
                    pageUtility.getUnstableBlocks();//查询所有不稳定 block 信息
                }, 1000)
            }
        })
    },

    //插入Mci信息
    searchMci(status) {
        pgclient.query("Select * FROM mci  WHERE last_stable_mci = $1", [Number(status.last_stable_mci)], (data) => {
            if (data.length > 1) {
                logger.info("searchMci is Error");
                logger.info(data);
                return;
            }else{
                let currentMci = data[0];
                if (data.length === 0) {
                    logger.info("数据库无Mci，第一次插入");
                    pageUtility.insertMci(status);
                } else if (data.length === 1) {
                    if(Number(currentMci.last_stable_mci)!==Number(status.last_stable_mci)){
                        logger.info("需要更新MCI");
                        pageUtility.insertMci(status);
                    }else{
                        pageUtility.getUnitByMci();//查询所有稳定 block 信息
                    }
                } 
            }
            
        });
    },
    insertMci(status){
        const mciText = 'INSERT INTO mci(last_mci,last_stable_mci) VALUES($1,$2)';
        const mciValues = [Number(status.last_mci),Number(status.last_stable_mci)];
        pgclient.query(mciText,mciValues,(res) => {
            let typeVal = Object.prototype.toString.call(res);
            if (typeVal === '[object Error]') {
                logger.info(`MCI插入失败 ${res}`);
            } else {
                logger.info(`MCI插入成功`);
                pageUtility.getUnitByMci();//查询所有稳定 block 信息
            }
        })
    },
    //插入稳定的Unit ------------------------------------------------ Start
    getUnitByMci(){
        logger.info(`通过 ${dbStableMci} ${MCI_LIMIT} ${next_index} 获取blocks ===============================`);
        profiler.start();
        czr.request.mciBlocks(dbStableMci,MCI_LIMIT,next_index).then(function (data) {
            profiler.stop('RPC=> mciBlocks');
            profiler.start();
            if(data.blocks){
                data.blocks.forEach((item) => {
                    //写 is_witness
                    if(WITNESS_ARY.indexOf(item.from)>-1){
                        item.is_witness = true;
                    }else{ 
                        item.is_witness = false;
                    }
                    unitInsertAry.push(item);
                });
                next_index = data.next_index ? data.next_index : '';
                profiler.stop('mciBlocks后Blocks重写');
                pageUtility.filterData();
            }else{
                logger.info(`mciBlocks : data.blocks => false`);
                logger.info(data);
                pageUtility.getRPC();
            }
        }).catch((err)=>{
            logger.info(`mciBlocks-Error : ${err}`);
        })
    },
    filterData(){
        profiler.start(); 
        //2、根据稳定Units数据，筛选Account Parent Witness Timestamp，方便后续储存
        unitInsertAry.forEach(blockInfo => {
            //DO 处理账户，发款方不在当前 accountsTotal 时 （以前已经储存在数据库了）
            if (!accountsTotal.hasOwnProperty(blockInfo.from)) {
                accountsTotal[blockInfo.from] = {
                    account: blockInfo.from,
                    type: 1,
                    balance: "0"
                }
            }

            //账户余额 只有是成功的交易才操作账户余额
            let isFail = pageUtility.isFail(blockInfo);//交易失败了
            if (!isFail) {
                //处理收款方余额
                if (accountsTotal.hasOwnProperty(blockInfo.to)) {
                    //有：更新数据
                    accountsTotal[blockInfo.to].balance = BigNumber(accountsTotal[blockInfo.to].balance).plus(blockInfo.amount).toString(10);
                } else {
                    //无：写入数据
                    accountsTotal[blockInfo.to] = {
                        account: blockInfo.to,
                        type: 1,
                        balance: blockInfo.amount
                    }
                }
                //处理发款方余额
                if (Number(blockInfo.level) !== 0) {
                    accountsTotal[blockInfo.from].balance = BigNumber(accountsTotal[blockInfo.from].balance).minus(blockInfo.amount).toString(10);
                }
            }

            //DO 处理 parents 数据
            if (blockInfo.parents.length > 0) {
                parentsTotalAry.push({
                    item:blockInfo.hash,
                    parent:blockInfo.parents,
                    is_witness:blockInfo.is_witness,
                    prototype:""
                });
            }

            // 处理witness
            if (blockInfo.witness_list.length > 0) {
                witnessTotal[blockInfo.hash] = blockInfo.witness_list;
            }

            //DO 交易
            unitAryForSql.push(blockInfo.hash);

            //DO timestamp 1秒
            //DO timestamp 10秒 timestamp10Total
            if(blockInfo.hasOwnProperty("mc_timestamp")){
                if (!timestampTotal.hasOwnProperty(blockInfo.mc_timestamp)) {
                    timestampTotal[blockInfo.mc_timestamp] = {
                        timestamp: blockInfo.mc_timestamp,
                        type: 1,
                        count: 1
                    }
                }else{
                    timestampTotal[blockInfo.mc_timestamp].count+=1;
                }
                //10
                if (!timestamp10Total.hasOwnProperty(self.formatTimestamp(blockInfo.mc_timestamp))) {
                    timestamp10Total[self.formatTimestamp(blockInfo.mc_timestamp)] = {
                        timestamp: self.formatTimestamp(blockInfo.mc_timestamp),
                        type: 10,
                        count: 1
                    }
                }else{
                    timestamp10Total[self.formatTimestamp(blockInfo.mc_timestamp)].count+=1;
                }

            }else{
                logger.info(`mc_timestamp-Error`);
            }

        });

        /*
        * 处理账户
        * 处理Parent
        * 处理Block
        * */
       profiler.stop('mciBlocks后数据组装');
       pageUtility.searchAccountBaseDb();
    },
    searchAccountBaseDb(){
        //处理账户
        let tempAccountAllAry = [];
        for (let item in accountsTotal) {
            tempAccountAllAry.push(item);
        }

        let upsertSql = {
            text: "select account from accounts where account = ANY ($1)",
            values: [tempAccountAllAry]
        };
        profiler.start();
        pgclient.query(upsertSql, (accountRes) => {
            profiler.stop('SQL=> selectAccountFromAccounts');
            profiler.start();
            accountRes.forEach(item => {
                if (accountsTotal.hasOwnProperty(item.account)) {
                    accountsUpdateAry.push(accountsTotal[item.account]);
                    delete accountsTotal[item.account];
                }
            });
            for (let item in accountsTotal) {
                accountsInsertAry.push(accountsTotal[item]);
            }
            profiler.stop('selectAccount后数据处理');
            logger.info(`Account 合计:${tempAccountAllAry.length} 更新:${accountsUpdateAry.length} 插入:${accountsInsertAry.length}`);
            pageUtility.searchTimestampBaseDb()

        });
    },
    searchTimestampBaseDb(){
        //处理Timestamp
        let tempTimesAllAry = [];
        for (let item in timestampTotal) {
            tempTimesAllAry.push(item);
        }

        let upsertSql = {
            text: "select timestamp from timestamp where timestamp = ANY ($1)",
            values: [tempTimesAllAry]
        };
        profiler.start();
        pgclient.query(upsertSql, (timestampRes) => {
            profiler.stop('SQL=> searchTimestamp');
            profiler.start();
            timestampRes.forEach(item => {
                if (timestampTotal.hasOwnProperty(item.timestamp)) {
                    timestampUpdateAry.push(timestampTotal[item.timestamp]);
                    delete timestampTotal[item.timestamp];
                }
            });
            for (let item in timestampTotal) {
                timestampInsertAry.push(timestampTotal[item]);
            }
            profiler.stop('searchTimestamp后的处理');
            logger.info(`Timestamp 合计:${tempTimesAllAry.length} 更新:${timestampUpdateAry.length} 插入:${timestampInsertAry.length}`);
            //处理Timestamp 结束

            //处理 10Timestamp 开始
            let tempTimes10AllAry = [];
            for (let item10 in timestamp10Total) {
                tempTimes10AllAry.push(item10);
            }
    
            let upsert10Sql = {
                text: "select timestamp from timestamp where timestamp = ANY ($1)",
                values: [tempTimes10AllAry]
            };
            profiler.start();
            pgclient.query(upsert10Sql, (timestampRes) => {
                profiler.stop('SQL=> searchTimestamp10');
                profiler.start();
                timestampRes.forEach(item => {
                    if (timestamp10Total.hasOwnProperty(item.timestamp)) {
                        timestamp10UpdateAry.push(timestamp10Total[item.timestamp]);
                        delete timestamp10Total[item.timestamp];
                    }
                });
                for (let item in timestamp10Total) {
                    timestamp10InsertAry.push(timestamp10Total[item]);
                }
                profiler.stop('searchTimestamp10后的处理');
                logger.info(`Timestamp10 合计:${tempTimes10AllAry.length} 更新:${timestamp10UpdateAry.length} 插入:${timestamp10InsertAry.length}`);

                //处理 10Timestamp 结束
                pageUtility.searchParentsBaseDb() //unBlock插入后，在mci插入，可能有些是插入后的
    
            });

        });
    },
    searchParentsBaseDb(){
        //处理Parent 不需要搜索哪些在数据库，直接插入即可啊；
        let tempParentsAllAry = [];
        parentsTotalAry.forEach(item=>{
            tempParentsAllAry.push(item.item);//key push 
        })

        let upsertParentSql = {
            text: "select item from parents where item = ANY ($1)",
            values: [tempParentsAllAry]
        };
        profiler.start();
        pgclient.query(upsertParentSql, (res) => {
            profiler.stop('SQL=> searchParentsBaseDb');
            profiler.start();
            let hashParentObj = {};
            res.forEach((item) => {
                hashParentObj[item.item] = item.item;
            });
            let beforParentLeng = Object.keys(parentsTotalAry).length;
            for (let parent in hashParentObj) {
                parentsTotalAry.forEach((item,index)=>{
                    if(item.item==parent){
                        parentsTotalAry.splice(index,1);
                    }
                })
            }
            profiler.stop('searchParents后数据处理');
            logger.info(`Parents 合计:${beforParentLeng}, 已存在:${Object.keys(hashParentObj).length}, 需处理:${Object.keys(parentsTotalAry).length}`);//parentsTotalAry 是目标数据 
            pageUtility.writePrototype(parentsTotalAry ,'1', pageUtility.searchBlockBaseDb)
        });
    },
    searchBlockBaseDb(){
        //处理Block unBlock插入后，在mci插入，可能有些是插入后的
        let upsertBlockSql = {
            text: "select hash from transaction where hash = ANY ($1)",
            values: [unitAryForSql]
        };
        profiler.start();
        pgclient.query(upsertBlockSql, (blockRes) => {
            profiler.stop('SQL=> searchBlockBaseDb');
            profiler.start();
            blockRes.forEach(dbItem => {
                for (let i= 0;i<unitInsertAry.length;i++){
                    if(unitInsertAry[i].hash === dbItem.hash){
                        unitUpdateAry.push(unitInsertAry[i]);
                        unitInsertAry.splice(i,1);
                        i--;
                    }
                }
            });
            unitInsertAry = [].concat(unitInsertAry);
            profiler.stop('searchBlock后续处理');
            logger.info(`Block 合计:${unitAryForSql.length}, 需更新:${unitUpdateAry.length}, 需插入:${unitInsertAry.length}`);
            pageUtility.searchWitnessBaseDb();
        });
    },
    searchWitnessBaseDb(){
        // 处理witness  witnessTotal
        let witnessAllAry = [];
        for (let item in witnessTotal) {
            witnessAllAry.push(item);
        }
        let upsertWitnessSql = {
            text: "select item from witness where item = ANY ($1)",
            values: [witnessAllAry]
        };
        profiler.start();
        pgclient.query(upsertWitnessSql, (witnessRes) => {
            profiler.stop('SQL=> searchWitnessBaseDb');
            profiler.start();
            let hashWitnessObj = {};
            witnessRes.forEach((item) => {
                hashWitnessObj[item.item] = item.item;
            });
            let beforeWitnsLeng = Object.keys(witnessTotal).length;
            for (let witness in hashWitnessObj) {
                delete witnessTotal[witness];
            }
            profiler.stop('searchWitness后续操作');
            logger.info(`合计有 Witness:${beforeWitnsLeng}, 已存在:${Object.keys(hashWitnessObj).length} 需处理:${Object.keys(witnessTotal).length}`);
            
            pageUtility.batchInsertStable();
        })
    },
    batchInsertStable(){
        //批量提交
        logger.info("准备批量插入稳定账户、Parent、Block，并批量更新Block **");
        profiler.start();
        pgclient.query('BEGIN', (res) => {
            if (pageUtility.shouldAbort(res, "操作稳定BlockStart")) {
                return;
            }
            /*
            * 批量插入 账户       accountsInsertAry
            * 批量插入 时间       timestampInsertAry
            * 批量插入 时间       timestamp10InsertAry
            * 批量插入 Parent、   parentsTotalAry:Ary
            * 批量插入 Witness    witnessTotal:object
            * 批量插入 Block、    unitInsertAry
            * 批量更新 Block、    unitUpdateAry
            * */
           
            if (accountsInsertAry.length > 0) {
                pageUtility.batchInsertAccount(accountsInsertAry);
            }
            if (timestampInsertAry.length > 0) {
                pageUtility.batchInsertTimestamp(timestampInsertAry);
            }
            if (timestamp10InsertAry.length > 0) {
                pageUtility.batchInsertTimestamp(timestamp10InsertAry);
            }
            if (parentsTotalAry.length > 0) {
                pageUtility.batchInsertParent(parentsTotalAry);
            }
            if (Object.keys(witnessTotal).length > 0) {
                pageUtility.batchInsertWitness(witnessTotal);
            }

            if (unitInsertAry.length > 0) {
                pageUtility.batchInsertBlock(unitInsertAry);
            }

            if (unitUpdateAry.length > 0) {
                pageUtility.batchUpdateBlock(unitUpdateAry);
            }

            pgclient.query('COMMIT', (err) => {
                profiler.stop('SQL批量=> batchInsertStable');
                logger.info(`批量插入稳结束, 需更新Account:${accountsUpdateAry.length} 需更新timestamp:${timestampUpdateAry.length} 需更新timestamp10:${timestamp10UpdateAry.length}`);
                /* 
                批量更新账户、       accountsUpdateAry
                */
               profiler.start();
                accountsUpdateAry.forEach(account => {
                    pageUtility.aloneUpdateAccount(account)
                });
                timestampUpdateAry.forEach(timestamp => {
                    pageUtility.aloneUpdateTimestamp(timestamp)
                });
                timestamp10UpdateAry.forEach(timestamp => {
                    pageUtility.aloneUpdateTimestamp(timestamp);
                });
                profiler.stop('SQL=> updateAccountTimestamp');
                //归零数据
                unitInsertAry = [];
                accountsTotal = {};
                parentsTotalAry = [];
                witnessTotal = {};
                unitAryForSql = [];//用来从数据库搜索的数组
                accountsUpdateAry=[];
                unitUpdateAry =[];
                accountsInsertAry=[];

                timestampTotal = {};
                timestampInsertAry=[];
                timestampUpdateAry=[];

                timestamp10Total = {};
                timestamp10InsertAry=[];
                timestamp10UpdateAry=[];


                //Other
                isStableDone = dbStableMci < rpcStableMci ? false : true;
                logger.info(`本次操作数据库稳定MCI:${dbStableMci}, RPC稳定Mci:${rpcStableMci},是否完成稳定MCI的操作:${isStableDone}`);

                if((dbStableMci%1000==0)&&dbStableMci!==0){
                    console.log(dbStableMci);
                    profiler.print();
                }
                if (!isStableDone) {
                    if(!next_index){
                        //处理 xxx 和 isDone
                        dbStableMci++;
                        if (dbStableMci  <= rpcStableMci) {
                            //数量太多，需要分批插入
                            isStableDone = false;
                        } else {
                            //下一次可以插入完
                            isStableDone = true;
                        }
                    }
                    pageUtility.getUnitByMci();
                } else {
                    //最后：获取 不稳定的unstable_blocks 存储
                    pageUtility.getUnstableBlocks();
                }
            })
        });
    },
    //插入稳定的Unit ------------------------------------------------ End

    //插入不稳定的Unit ------------------------------------------------ Start
    getUnstableBlocks() {
        unstableUnitHashAry     = [];
        unstableParentsAry      = [];
        unstableWitnessTotal    = {};
        unstableInsertBlockAry  = [];
        unstableUpdateBlockAry  = [];
        logger.info("插入不稳定的Unit-----------++++++",MCI_LIMIT,unstable_next_index)
        czr.request.unstableBlocks(MCI_LIMIT,unstable_next_index).then(function (data) {
            unstableInsertBlockAry = data.blocks;
            unstable_next_index = data.next_index ? data.next_index : '';
            if(unstableInsertBlockAry.length>0){
                //@A 拆分数据
                unstableInsertBlockAry.forEach(blockInfo => {
                     //写 is_witness
                     if(WITNESS_ARY.indexOf(blockInfo.from)!=-1){
                        blockInfo.is_witness = true;
                    }else{ 
                        blockInfo.is_witness = false;
                    }
                    //处理parents
                    if (blockInfo.parents.length > 0) {
                        // {"AAAA":["BBB","CCC"]}
                        unstableParentsAry.push({
                            item:blockInfo.hash,
                            parent:blockInfo.parents,
                            is_witness:blockInfo.is_witness,
                            prototype:""
                        })
                    }
                    //处理witness
                    if (blockInfo.witness_list.length > 0) {
                        // {"AAAA":["BBB","CCC"]}
                        unstableWitnessTotal[blockInfo.hash] = blockInfo.witness_list;
                    }
                    //处理Unit Hash
                    unstableUnitHashAry.push(blockInfo.hash);
                });


                /* 
                1.筛选好需要操作的Parent
                2.筛选好需要操作的Witness
                3.筛选好需要更新的Block
                筛选好需要插入的Block
                */
                pageUtility.searchParentsFromDb();
            }else{
                logger.info("unstable的blocks是空的,需要从头跑")
                logger.info(data);
                pageUtility.readyGetData();
            }
        })
    },
    //1.搜索哪些Parents已经存在数据库中,并把 unstableParentsAry 改为最终需要处理的数据
    searchParentsFromDb(){
        let unstableParentsAllAry = [];
        unstableParentsAry.forEach(item=>{
            unstableParentsAllAry.push(item.item);//key push 
        })

        let upsertParentSql = {
            text: "select item from parents where item = ANY ($1)",
            values: [unstableParentsAllAry]
        };
        pgclient.query(upsertParentSql, (res) => {
            let hashParentObj = {};//数据库中存在的parents
            res.forEach((item) => {
                hashParentObj[item.item] = item.item;
            });
            let beforUnParentLen = unstableParentsAry.length;
            for (let parent in hashParentObj) {
                unstableParentsAry.forEach((item,index)=>{
                    if(item.item==parent){
                        unstableParentsAry.splice(index,1);
                    }
                })
            }
            logger.info(`Parents 合计有:${beforUnParentLen} 已存在:${Object.keys(hashParentObj).length} 需处理:${unstableParentsAry.length}`);
            pageUtility.writePrototype(unstableParentsAry ,'2', pageUtility.searchWitnessFromDb)
            // pageUtility.searchWitnessFromDb();
        });
    },
    writePrototype(sources_ary,flag,fn){
        profiler.start();
        //falg : 1=>稳定 2=>不稳定
        let tempAry=[];
        let dbParents = [];//已经再数据里的数据
        let allUnit = [];//当前所有的unit
        let allParent = [];//当前所有的parent
        sources_ary.forEach(item=>{
            item.parent.forEach(childrenItem=>{
                tempAry.push({
                    item:item.item,
                    parent:childrenItem,//单个parents
                    is_witness:item.is_witness,
                    prototype:item.prototype
                });
                allUnit.push(item.item);//判断parent的值有哪里是已经存在allUnit的
                allParent.push(childrenItem);//判断parent的值有哪里是已经存在allParent的
            })
        })
        sources_ary = tempAry;
        /* 
        写unit对应 prototype 值:
        1.unit对应parent的是在哪里，可能存在当前数组，也可能在Db中；需要进行分类
        2.先批量查Db里parents的is_witness
            T:则unit的 prototype 为 parent
            F:则unit的 prototype 为 parent.prototype
        3.再把存在当前数据里的进行处理
        */
       sources_ary.forEach((item,index)=>{
           if(allUnit.indexOf(item.parent)<0){
               dbParents.push(item.parent);//存在Db里
           }
       })
       profiler.stop("writePrototype前置处理");
       let searchParentsSql = {
            text: "select item,parent,is_witness,prototype from parents where item = ANY ($1)",
            values: [dbParents]
        };
        profiler.start();
        pgclient.query(searchParentsSql, (parentsRes) => {
            profiler.stop("SQL=> SearchFromParents");
            profiler.start();
            let itemIndex=0;
            let dbHashParent = []
            logger.info(`展开后需插表parents:${sources_ary.length}  (${flag=='1'?'稳定的':'不稳定的'}) 数据库中存在parents:${parentsRes.length}`)
            //根据数据库的写当前的prototype
            if(parentsRes.length>0){
                let hubObj = pageUtility.writeHub(parentsRes);
                parentsRes.forEach(item=>{
                    itemIndex = allParent.indexOf(item.item);
                    allParent[itemIndex]="IS_GET";
                    dbHashParent.push(item.item);
                    /* 
                        TODO：如果DE指向C，C指向AB；
                        C的is_witness为true，则DE的prototype值均为C；
                        C的is_witness为false,那么DE的prototype值是C(C此时是枢纽)

                        如果C后面不是DE，而是单独一个F；
                        C的is_witness为true，则F的prototype值为C；
                        C的is_witness为false,那么F的prototype为C，此时值是
                    */
                    if(itemIndex>-1){
                        if(item.is_witness){
                            //当前是witness
                            sources_ary[itemIndex].prototype = item.item;
                        }else{
                            //非witness
                            sources_ary[itemIndex].prototype = hubObj[item.item].prototype;
                        }
                    }
                }); 
            }

            //根据当前的写当前的prototype
            let currentItemIndex=0;
            let targetItem={};
            sources_ary.forEach((currentItem,index)=>{
                currentItemIndex = allUnit.indexOf(currentItem.parent); 
                if(currentItemIndex>-1){
                    targetItem =sources_ary[currentItemIndex];
                    if(targetItem.is_witness){
                        currentItem.prototype = targetItem.item;
                    }else{
                        currentItem.prototype = targetItem.prototype;
                        /* 
                            需要判断是否为枢纽，
                                1.非见证人
                                2.多个原型
                            =如果多个原型，则取出对应的原型
                                fn(sources_ary , targetItem.item) => 'B,C,D'
                            =如果是空字符串则代表不是枢纽
                        */
                       //如果是枢纽，prototype的是item.item;
                       currentItem.prototype = pageUtility.getLocalHubInfo(sources_ary,targetItem.prototype);
                    }
                }

                //循环当前数组，这一步是处理假设AB同时指向C，C指向D；数据库只能查出的1条C；循环C，只会写A，B的proto会漏写
                let localItemIndex= dbHashParent.indexOf(currentItem.parent);
                if(localItemIndex>-1 && (!currentItem.prototype)){
                    if(parentsRes[localItemIndex].is_witness){
                        sources_ary[index].prototype = parentsRes[localItemIndex].item;
                    }else{
                        sources_ary[index].prototype = parentsRes[localItemIndex].prototype;
                    }
                }
            })
            
            //赋值对应的数据
            if(flag == "1"){
                //赋值稳定的
                parentsTotalAry = sources_ary;
            }else if(flag =="2"){
                //赋值不稳定的
                unstableParentsAry = sources_ary;
            }
            profiler.stop('SearchParents后续操作');
            fn();
        })
    },
    //2.搜索哪些Witness已经存在数据库中,并把 unstableWitnessTotal 改为最终需要处理的数据
    searchWitnessFromDb(){
        let unstableWitnessAllAry = [];
        for (let item in unstableWitnessTotal) {
            unstableWitnessAllAry.push(item);//push key 
        }
        let upsertWitnessSql = {
            text: "select item from witness where item = ANY ($1)",
            values: [unstableWitnessAllAry]
        };
        pgclient.query(upsertWitnessSql, (witnessRes) => {
            let hashWitnessObj = {};
            witnessRes.forEach((item) => {
                hashWitnessObj[item.item] = item.item;
            });
            let beforeUnWitLen = Object.keys(unstableWitnessTotal).length;
            for (let witness in hashWitnessObj) {
                delete unstableWitnessTotal[witness];
            }
            logger.info(`Witness 合计有:${beforeUnWitLen} 已存在${Object.keys(hashWitnessObj).length} 需处理:${Object.keys(unstableWitnessTotal).length}`);
            pageUtility.searchHashFromDb();
        })
    },

    //3.搜索哪些hash已经存在数据库中,哪些
    searchHashFromDb(){
        let upsertBlockSql = {
            text: "select hash from transaction where hash = ANY ($1)",
            values: [unstableUnitHashAry]
        };
        pgclient.query(upsertBlockSql, (blockRes) => {
            blockRes.forEach(dbItem => {
                for (let i= 0;i<unstableInsertBlockAry.length;i++){
                    if(unstableInsertBlockAry[i].hash === dbItem.hash){
                        unstableUpdateBlockAry.push(unstableInsertBlockAry[i]);
                        unstableInsertBlockAry.splice(i,1);
                        i--;
                    }
                }
            });
            logger.info(`不稳定BlockHash 合计有:${unstableUnitHashAry.length} 表里有:${blockRes.length} 更新:${unstableUpdateBlockAry.length} 需插入:${unstableInsertBlockAry.length}`);
            pageUtility.batchInsertUnstable();
        });
    },

    batchInsertUnstable(){
        //开始插入数据库
        pgclient.query('BEGIN', (res) => {
            logger.info("++ 批量操作不稳定 Unit Start ++");
            if (pageUtility.shouldAbort(res, "操作不稳定BlockStart")) {
                return;
            }
            /*
            * 批量插入 Parent、   unstableParentsAry
            * 批量插入 Witness   unstableWitnessTotal:object
            * 批量插入 Block、    unstableInsertBlockAry
            * 批量更新 Block、    unstableUpdateBlockAry
            * */
            if (unstableParentsAry.length > 0) {
                pageUtility.batchInsertParent(unstableParentsAry);
            }

            if (Object.keys(unstableWitnessTotal).length > 0) {
                pageUtility.batchInsertWitness(unstableWitnessTotal);
            }

            if (unstableInsertBlockAry.length > 0) {
                pageUtility.batchInsertBlock(unstableInsertBlockAry);
            }
            if (unstableUpdateBlockAry.length > 0) {
                pageUtility.batchUpdateBlock(unstableUpdateBlockAry);
            }
            pgclient.query('COMMIT', (err) => {
                logger.info("批量操作不稳定 Unit End", err);

                if(unstable_next_index){
                    //没有获取完，需要获取
                    pageUtility.getUnstableBlocks();
                }else{
                    //已经获取完毕了
                    pageUtility.readyGetData();
                }
            })
        })
    },
    
    // 插入不稳定的Unit ------------------------------------------------ End

    //批量插入witness
    batchInsertWitness(witnessObj) {
        // let witnessObj={
        //     '5D81C966F0E1B1DFA0F77488FD4A577BB557CBEF4C87DE39141CB0FF7639F583': [ 'AAA' ],
        //     '94960D6352BC14287A68327373B45E0D8F21BC4C434287C893BD0DF9100E4F35':
        //         [ 'BBB',
        //             'CCC',
        //             'DDD' ]
        // };
        let tempAry = [];
        for (let key in witnessObj) {
            witnessObj[key].forEach((item) => {
                tempAry.push("('" + key + "','" + item + "')");
            });
        }
        let batchInsertSql = {
            text: "INSERT INTO witness (item,account) VALUES" + tempAry.toString()
        };
        pgclient.query(batchInsertSql, (res) => {
            //ROLLBACK
            if (pageUtility.shouldAbort(res, "batchInsertWitness")) {
                return;
            }
        });
    },

    //批量插入Parent
    batchInsertParent(parentAry){
        /* 
        let parentAry=[
            {
                item:"xxxx",
                parent:"AAA",
                is_witness:true,
                prototype:""
            },
        ];
        */
       //
       logger.info("批量插入了")
        let tempAry=[];
        parentAry.forEach(item=>{
            tempAry.push("('"+item.item+"','"+item.parent+ "','"+ item.is_witness + "','"+ item.prototype  +"')");
        })        
        let batchInsertSql = {
            text: "INSERT INTO parents (item,parent,is_witness,prototype) VALUES "+tempAry.toString()
        };
        pgclient.query(batchInsertSql, (res) => {
            //ROLLBACK
            if(pageUtility.shouldAbort(res,"batchInsertParent")){
                return;
            }
        });
    },

    //批量插入账户
    batchInsertAccount(accountAry) {
        // accountAry=[{
        //         account: 'czr_341qh4575khs734rfi8q7s1kioa541mhm3bfb1mryxyscy19tzarhyitiot6',
        //         type: 1,
        //         balance: '0'
        //     },
        //     {
        //         account: 'czr_3n571ydsypy34ea5c7w6z7owyc1hxqgbnqa8em8p6bp6pkk3ii55j14btpn6',
        //         type: 1,
        //         balance: '0'
        //     }];
        let tempAry = [];
        accountAry.forEach((item) => {
            tempAry.push("('" + item.account + "'," + item.type + "," + item.balance + ")");
        });
        let batchInsertSql = {
            text: "INSERT INTO accounts (account,type,balance) VALUES" + tempAry.toString()
        };
        pgclient.query(batchInsertSql, (res) => {
            //ROLLBACK
            if (pageUtility.shouldAbort(res, "batchInsertAccount")) {
                return;
            }
        });
    },
    //批量插入 timestamp
    batchInsertTimestamp(timestampAry){
        // timestampAry=[{
        //         timestamp: '11111',
        //         type: 1,
        //         count: '0'
        //     },
        //     {
        //         timestamp: '2222',
        //         type: 1,
        //         balance: '0'
        //     }];
        let tempAry = [];
        timestampAry.forEach((item) => {
            tempAry.push("('" + item.timestamp + "'," + item.type + "," + item.count + ")");
        });
        //timestampAry
        let batchInsertSql = {
            text: "INSERT INTO timestamp (timestamp,type,count) VALUES" + tempAry.toString()
        };
        pgclient.query(batchInsertSql, (res) => {
            //ROLLBACK
            if (pageUtility.shouldAbort(res, "batchInsertTimestamp")) {
                return;
            }
        });
    },

    //批量插入Block
    batchInsertBlock(blockAry) {
        let tempAry = [];
        blockAry.forEach((item) => {
            tempAry.push(
                "('" +
                item.hash + "','" +
                item.from + "','" +
                item.to + "','" +
                item.amount + "','" +
                item.previous + "','" +
                item.witness_list_block + "','" +
                item.last_summary + "','" +
                item.last_summary_block + "','" +
                item.data + "'," +
                (Number(item.exec_timestamp) || 0) + ",'" +
                item.signature + "'," +
                (item.is_free === '1') + ",'" +
                item.is_witness + "','" +
                item.level + "','" +
                item.witnessed_level + "','" +
                item.best_parent + "'," +
                (item.is_stable === '1') + "," +
                Number(item.status) + "," +
                (item.is_on_mc === '1') + "," +
                (Number(item.mci) || -1) + "," +//item.mci可能为null
                (Number(item.latest_included_mci) || 0) + "," +//latest_included_mci 可能为0 =>12303
                (Number(item.mc_timestamp) || 0) +
                ")");

            if (!Number(item.exec_timestamp)) {
                logger.log("exec_timestamp 错了", item.mci, item.hash, item.latest_included_mci)
            }
            if (!Number(item.mci)) {
                logger.log("mci 错了", item.mci, item.hash, item.mci)
            }
            if (!Number(item.latest_included_mci)) {
                logger.log("latest_included_mci 错了", item.mci, item.hash, item.latest_included_mci)
            }
            if (!Number(item.mc_timestamp)) {
                logger.log("mc_timestamp 错了", item.mci, item.hash, item.mc_timestamp)
            }
        });

        let batchInsertSql = {
            text: 'INSERT INTO transaction(hash,"from","to",amount,previous,witness_list_block,last_summary,last_summary_block,data,exec_timestamp,signature,is_free,is_witness,level,witnessed_level,best_parent,is_stable,"status",is_on_mc,mci,latest_included_mci,mc_timestamp) VALUES' + tempAry.toString()
        };
        pgclient.query(batchInsertSql, (res) => {
            //ROLLBACK
            if (pageUtility.shouldAbort(res, "batchInsertBlock")) {
                return;
            }
        });
    },

    //批量更新Block
    batchUpdateBlock(updateBlockAry) {
        /*
        ﻿update transaction set
            is_free=tmp.is_free ,
            is_stable=tmp.is_stable ,
            status=tmp.status ,
            is_on_mc=tmp.is_on_mc
        from (values
              ('B5956299E1BC73B23A56D4CC1C58D42F2D494808FBDEE073259B48F571CCE97C',true,true,true,true,true,true),
              ('5F2B6FA741A33CDD506C5E150E37FCC73842082B24948A7159DFEB4C07500A08',true,true,true,true,true,true)
             )
        as tmp (hash,is_free,is_stable,status,is_on_mc)
        where
            transaction.hash=tmp.hash
        * */
        let tempAry = [];
        updateBlockAry.forEach((item) => {
            tempAry.push(
                "('" +
                item.hash + "'," +
                (item.is_free === '1') + "," +
                (item.is_stable === '1') + "," +
                item.status + "," +
                (item.is_on_mc === '1') + "," +
                (item.mc_timestamp) +
                ")");
        });
        let batchUpdateSql = 'update transaction set is_free=tmp.is_free , is_stable=tmp.is_stable , "status"=tmp.status , is_on_mc=tmp.is_on_mc , mc_timestamp=tmp.mc_timestamp from (values ' + tempAry.toString() +
            ') as tmp (hash,is_free,is_stable,"status",is_on_mc,mc_timestamp) where transaction.hash=tmp.hash';
        pgclient.query(batchUpdateSql, (res) => {
            //ROLLBACK
            if (pageUtility.shouldAbort(res, "batchUpdateBlock")) {
                return;
            }
        });
    },

    //单独更新
    aloneUpdateAccount(accountObj) {
        //需要先获取金额，然后再进行相加
        pgclient.query("Select * FROM accounts  WHERE account = $1", [accountObj.account], (data) => {
            let currentAccount = data[0];
            let targetBalance = BigNumber(currentAccount.balance).plus(accountObj.balance).toString(10);
            const sqlOptions = {
                text: "UPDATE accounts SET balance=$2 WHERE account=$1",
                values: [accountObj.account, targetBalance]
            };
            pgclient.query(sqlOptions, (res) => {
                let typeVal = Object.prototype.toString.call(res);
                if (typeVal === '[object Error]') {
                    logger.info(`Account更新失败 ${accountObj.account}`);
                    logger.info(res);
                    logger.info(`Account再次更新 ${accountObj.account}`);
                    pageUtility.aloneUpdateAccount(accountObj);
                }
            });
        });
    },
    aloneUpdateTimestamp(timestampObj){
        //需要先获取time,然后再进行相加
        pgclient.query("Select * FROM timestamp  WHERE timestamp = $1", [timestampObj.timestamp], (data) => {
            let currentTime = data[0];
            let targetCount = BigNumber(currentTime.count).plus(timestampObj.count).toString(10);
            const sqlOptions = {
                text: "UPDATE timestamp SET count=$2 WHERE timestamp=$1",
                values: [timestampObj.timestamp, targetCount]
            };
            pgclient.query(sqlOptions, (res) => {
                let typeVal = Object.prototype.toString.call(res);
                if (typeVal === '[object Error]') {
                    logger.info(`timestamp 更新失败 ${timestampObj.timestamp}`);
                    logger.info(res);
                    logger.info(`timestamp 再次更新 ${timestampObj.timestamp}`);
                    pageUtility.aloneUpdateTimestamp(timestampObj);
                }
            });
        });
    },

    writeHub(arr) {
        let obj = {};
        for (let i = 0; i < arr.length; i++) {
            let currentItem = arr[i];
            //currentItem.prototype 可能是 'AAA,BBB'
            let protoAry = currentItem.prototype.split(',');
            if (!obj[currentItem.item]) {
                obj[currentItem.item] = {
                    item:currentItem.item,
                    prototype: (protoAry.length>1 ? protoAry :[currentItem.prototype])
                };
            } else {
                protoAry.forEach(item=>{
                    if(obj[currentItem.item].prototype.indexOf(item)<0){
                        obj[currentItem.item].prototype.push(item);
                    }
                })
            }
    
        }
        /* 
        { '2319A50CBBAE851327E2B411430EE5718EB6415AC85FC6123853813C5F0F1D63': 
                { 
                    item: '2319A50CBBAE851327E2B411430EE5718EB6415AC85FC6123853813C5F0F1D63',
                    prototype: [ 
                        'ECE786885C9985104DB676A22442784DB1C7CBCC719CC3527B01417A950A4F88',
                        'ECE786885C9985104DB676A22442784DB1C7CBCC719CC3527B01417A950A4F88' 
                    ]
                } 
        }
        */
       for(let key in obj){
           obj[key].prototype = obj[key].prototype.join(',');
       }
        return obj;
    },
    getLocalHubInfo(ary,hash){
        let tempProto=[];
        ary.forEach(item=>{
            if(item.item===hash){
                let proAry = item.prototype.split(",");
                proAry.forEach(childItem=>{
                    //没有的前提下，再push
                    if(tempProto.indexOf(childItem)<0){
                        tempProto.push(childItem);
                    }
                })
            }
        })
        return tempProto.join(",");
    },
    shouldAbort(err, sources) {
        let typeVal = Object.prototype.toString.call(err);
        if (typeVal === '[object Error]') {
            logger.error(`Error in ${sources}`);
            logger.error(err);
            pgclient.query('ROLLBACK', (roll_err) => {
                if (Object.prototype.toString.call(roll_err) === '[object Error]') {
                    logger.error(`Error rolling back client ${sources}`);
                    logger.error(roll_err);
                }
                logger.info(`已经ROLLBACK了`);
                // release the client back to the pool
                // pageUtility.readyGetData();
            })
        }
        return typeVal === '[object Error]'
    },
    formatTimestamp(mc_timestamp){
        return Math.floor(mc_timestamp/10);
    },
    isFail(obj) {
        //true 是失败的
        return (obj.is_stable === "1") && (obj.status !="0");
    }
};
pageUtility.init();