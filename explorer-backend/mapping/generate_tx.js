(async () => {
    let Czr = require("czr");
    let czr = new Czr();
    let pgPromise = require("../database/PG-promise");
    let client = await pgPromise.pool.connect(); //获取连接
    let BigNumber = require('bignumber.js').default;

    // logger
    let log4js = require('../database/log_config');
    let logger = log4js.getLogger('mapping_generate_sql');

    //需要改为正式的 ****************************************************
    let generateOpt = require("./config/generate_opt")
    // let generate_opt = {
    //     "from": "czr_33EuccjKjcZgwbHYp8eLhoFiaKGARVigZojeHzySD9fQ1ysd7u",
    //     "to": "",
    //     "amount": "",
    //     "previous": "",
    //     "gas": "21000",
    //     "gas_price": "50000000000000"
    // }
    let getSqlTimer = null;
    let tempPrevious = '';
    let send_balance = "";
    /**
     * 1.从数据库取status=1的值
     * 2.用获取到的值生成离线交易账单
     * 3.储存生成的账单，并且更改status=2
     * 4.循环第一步
     */
    logger.info(" ************************** 开始 **************************");

    let pageUtility = {
        init() {
            getSqlTimer = setTimeout(function () {
                pageUtility.getAccInfo();
            }, 5000);
        },
        async getAccInfo() {
            //插入时候已经限制回退12Block了
            // let comfirmedBlockNumber = ethblockNumber - 12;

            let SearchOptions = {
                text: `
                    select 
                        "tx","czr_account","value"
                    from 
                        mapping_eth_log 
                    where 
                        "status" = $1
                    order by
                        mapping_log_id asc
                    limit
                        1
                `,
                values: [1]
            };

            try {
                let data = await client.query(SearchOptions);
                //previous 用 send_block 发是没用的
                tempPrevious = await pageUtility.getLatestHash(); //从数据库获取
                pageUtility.generateBlock(data.rows, tempPrevious)
            } catch (error) {
                logger.info("getAccInfo 出错了")
                logger.error(error)
                throw error;
            }
        },
        async generateBlock(txAry, previous, is_repeat) {
            let temItem;
            if (!txAry.length) {
                // logger.info("暂无需要处理的交易")
                if (!is_repeat) {
                    pageUtility.init();
                }
                return;
            }

            //TODO
            //mapping_eth_log 增加 
            //  czr_txhash
            //  patrol_time 巡检时间
            //  send_error


            try {
                let accObj = await czr.request.accountBalance(generateOpt.from); //todo:获取send账号余额
                if (accObj.code === 0) {
                    send_balance = accObj.balance;
                } else {
                    logger.info("request.accountBalance code出错了")
                    logger.error(accObj)
                    throw "accountBalance code出错了";
                }
            } catch (error) {
                logger.info("request.accountBalance 出错了")
                logger.error(error)
                throw error;
            }
            temItem = txAry[0];

            //Bignumber 判断 大小
            let remainder = BigNumber(send_balance).minus(temItem.value).toNumber();
            logger.info(`send_balance:${send_balance} temItem.value：${temItem.value}`)
            if (remainder > 0) {
                generateOpt.to = temItem.czr_account;
                generateOpt.amount = temItem.value;
                generateOpt.previous = previous;

                // logger.info("generateOpt\n", generateOpt)

                let result;
                try {
                    result = await czr.request.generateOfflineBlock(generateOpt);
                    if (result.code === 0) {
                        tempPrevious = result.hash;
                        await pageUtility.insertSql(temItem.tx, result.previous);
                    } else if (result.code === 8) {
                        logger.info("余额不足!!!!!!!")
                        if (!is_repeat) {
                            pageUtility.init();
                        }
                        return;
                    } else {
                        logger.info("generateOfflineBlock code出错了")
                        logger.error(result)
                        throw "generateOfflineBlock code出错了";
                    }

                } catch (error) {
                    logger.info("generateOfflineBlock 出错了")
                    logger.error(error)
                    throw error;
                }

                logger.info("generateOfflineBlock result\n", result)
                logger.info("------------------------------------")



                try {
                    //sendBlock 不需要 Previous 参数
                    let sendResult = await czr.request.sendBlock(generateOpt);
                    if (sendResult.code === 0) {
                        //TODO:generateOpt增加巡检时间
                        await pageUtility.updateCzrHash(temItem.tx, sendResult.hash);
                    } else {
                        logger.info("sendResult 出错了")
                        logger.error(sendResult)
                        throw "request.sendBlock 出错了";
                    }
                    if (!is_repeat) {
                        pageUtility.init();
                    }
                } catch (error) {
                    logger.info("request.sendBlock 出错了")
                    logger.error(error.message)
                    //如果出错了
                    //todo: 更新send error, status = 4(发送错误)
                    await pageUtility.updateErrorStatus(temItem.tx, error.message);
                    if (!is_repeat) {
                        pageUtility.init();
                    }
                }
            } else {
                logger.info("余额不足")
                if (!is_repeat) {
                    pageUtility.init();
                }
                return;
            }
        },
        async updateCzrHash(tx, czr_hash) {
            let updateStatus = `
                update 
                    mapping_eth_log 
                set 
                    czr_txhash = '${czr_hash}',
                    patrol_time = ${Number(Date.parse(new Date())) + 10000}
                where 
                    tx= '${tx}'
            `
            try {
                await client.query(updateStatus);
            } catch (error) {
                logger.info("update Czr Hash 更新失败")
                logger.info(updateStatus)
                logger.info(error)
                throw error;
            }
        },
        async updateErrorStatus(tx, message) {
            let updateStatus = `
                update 
                    mapping_eth_log 
                set
                    status = 4,
                    send_error = '${message}'
                where
                    tx= '${tx}'
            `
            try {
                await client.query(updateStatus);
            } catch (error) {
                logger.info("updateErrorStatus 更新失败")
                logger.info(updateStatus)
                logger.info(error)
                throw error;
            }
        },
        //插入最后一笔交易的hash(tempPrevious)，和更新status需要在一个事务中
        async insertSql(tx, previous) {
            //更新eth_log表
            let updateStatus = `
                update 
                    mapping_eth_log 
                set 
                    status = 2,
                    previous = '${previous}'
                where 
                    tx= '${tx}'
            `
            //更新latest_hash 目前这条更新的数据没有用处
            let updateHashSql = `
                update 
                    mapping_block_number
                set
                    value = '${tempPrevious}'
                where 
                    key = 'latest_hash'
            `;

            logger.info("准备插入")
            try {
                await client.query('BEGIN')
                await client.query(updateStatus);
                await client.query(updateHashSql);
                await client.query('COMMIT')
                logger.info("插入成功\n")
            } catch (errore) {
                logger.info("插入失败")
                logger.info(updateStatus)
                logger.info(error)
                throw error;
            }
        },
        async getLatestHash() {
            let sql = {
                text: `
                    Select 
                        "key","value"
                    FROM 
                        mapping_block_number
                    where
                        "key" ='latest_hash'
                `,
                values: []
            }
            try {
                let blockInfo = await pgPromise.query(sql);
                return blockInfo.rows.length ? blockInfo.rows[0].value : "";
            } catch (error) {
                logger.info("getLatestHash 出错了")
                logger.error(error)
                throw error;
            }
        }
    }
    pageUtility.getAccInfo();


    //巡检逻辑

    let getPatrolTimer = null;
    let patrol = {
        init() {
            getPatrolTimer = setTimeout(function () {
                patrol.start();
            }, 1000 * 10);
        },
        async start() {
            let nowTime = Number(Date.parse(new Date()));
            let SearchOptions = {
                text: `
                    select 
                        "tx","czr_txhash","patrol_time",
                        "czr_account","value","previous"
                    from 
                        mapping_eth_log 
                    where 
                        "status" = $1
                        and
                        "patrol_time" < ${nowTime}
                    order by 
                        mapping_log_id asc
                `,
                values: [2]
            };

            try {
                let data = await client.query(SearchOptions);
                patrol.checkStatus(data.rows);
            } catch (error) {
                logger.info("查询status2 出错了")
                logger.error(error)
                throw error;
            }
        },
        async checkStatus(txAry) {
            let temAry = [];
            if (!txAry.length) {
                logger.info("暂无需要更新的交易-巡检")
                patrol.init();
                return;
            }
            txAry.forEach(element => {
                temAry.push(element.czr_txhash)
            });

            try {
                let blockStates = await czr.request.getBlockStates(temAry); //todo:获取send账号余额
                if (blockStates.code === 0) {
                    await patrol.filterData(blockStates.block_states, txAry);
                } else {
                    logger.info("request.getBlockStates Error")
                    logger.info(blockStates)
                    throw "request.getBlockStates Error";
                }
            } catch (error) {
                logger.info("checkStatus 出错了")
                logger.error(error)
                throw error;
            }

        },
        async filterData(statusAry, txAry) {
            let tempItem;

            for (let index = 0, len = statusAry.length; index < len;) {
                tempItem = statusAry[index];
                //稳定的
                if (tempItem && (tempItem.is_stable === 1)) {
                    switch (tempItem.stable_content.status) {
                        case 0:
                            //成功 将status设为3（成功）
                            try {
                                await client.query(patrol.getUptatusSql(tempItem.hash, 3));
                            } catch (error) {
                                logger.info("将status设为 3 出错了")
                                logger.error(error)
                                throw error;
                            }
                            break;
                        case 1:
                            //双花 将status设为4（失败，需人工处理）
                            try {
                                await client.query(patrol.getUptatusSql(tempItem.hash, 4));
                            } catch (error) {
                                logger.info("将status设为 4 出错了")
                                logger.error(error)
                                throw error;
                            }
                            break;
                        case 2:
                            //无效 将status设为1（即后面会重新发送）
                            try {
                                await client.query(patrol.getUptatusSql(tempItem.hash, 1));
                            } catch (error) {
                                logger.info("将status设为 1 出错了")
                                logger.error(error)
                                throw error;
                            }
                            break;
                        case 3:
                            //合约错误 将status设为4（失败，需人工处理）
                            try {
                                await client.query(patrol.getUptatusSql(tempItem.hash, 4));
                            } catch (error) {
                                logger.info("将status设为 4 出错了")
                                logger.error(error)
                                throw error;
                            }
                            break;
                        default:
                            logger.info("case到不存在的值", tempItem.stable_content.status)
                            throw `case到不存在的值，${tempItem.stable_content.status}`;
                    }
                } else {
                    logger.info(`不稳定`)
                    if (!tempItem) {
                        //为null时候重发 index
                        let reSend = txAry[index];
                        logger.info("准备重发", reSend)
                        try {
                            await pageUtility.generateBlock([reSend], reSend.previous, true)
                            logger.info("重发成功")
                        } catch (error) {
                            logger.info("重发出错了")
                            logger.error(error)
                            throw error;
                        }
                    }
                }
                if (tempItem) {
                    //为null时候重发 index
                    let reSend = txAry[index];
                    logger.info("准备重发", reSend)
                    try {
                        await pageUtility.generateBlock([reSend], reSend.previous, true)
                        logger.info("重发成功")
                    } catch (error) {
                        logger.info("重发出错了")
                        logger.error(error)
                        throw error;
                    }
                }

                index++;
            }

            //更新对应的值
            patrol.init();
        },
        getUptatusSql(czr_txhash, status) {
            //更新eth_log表
            let updateStatus = `
                update 
                    mapping_eth_log 
                set 
                    status = ${status}
                where 
                    czr_txhash= '${czr_txhash}'
            `
            return updateStatus;
        }
    }
    patrol.start();
})()