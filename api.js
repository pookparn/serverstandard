////////////////////////////////////////////////////////////////////
/// Web socket and http server for chat api.                  
/// Work flow - 1 Receive request data via websocket or http
///             2 Request format validation
///             3 Command implementation
////////////////////////////////////////////////////////////////////

var express = require('express')
  , app = express()
  , port = 4001;
////  =========- Read Configure File & LOG properties -========================///
var configurationFile = './config/main_config.json';
var fs = require('fs-extra');
var conf = JSON.parse(fs.readFileSync(configurationFile));
var log4js = require('log4js');
var logmodule = "MAIN"
log4js.configure({ "appenders": [conf.log4js_conf.ALL,conf.log4js_conf[logmodule]]});
var logger = log4js.getLogger(logmodule);
logger.setLevel(conf.loglevel[logmodule]);
////==========================================================================///

var server = require('http').createServer(app)
var url = require('url')
  , WebSocketServer = require('ws').Server
  , wss = new WebSocketServer({ server: server })
var bodyParser = require('body-parser');

var process = require('process'); 
var date = require("date-format-lite")
var ObjectID = require('mongodb').ObjectID;
var async = require("async");
var validator = require('is-my-json-valid');

var fieldconfigurationFile = './config/field_config.json';
var fieldconf = JSON.parse(fs.readFileSync(fieldconfigurationFile));

var mgs_mod = require('./mongoose_module.js');
var mgs_chat_mod = require('./mongoose_chat_module.js');
var authen_mod = require("./authen_module.js")("authen");
var subsc_mod = require("./subscriber_module.js")("subscriber");

var unique = require('array-unique').immutable;

/// ->> Connect to rabbitMQ
//var open = require('amqplib').connect('amqp://lmsapi:lmsapi132@localhost:5672');  

/// ->> Kafka
var kafka = require('kafka-node'),
    Producer = kafka.Producer,
    KeyedMessage = kafka.KeyedMessage,
    client = new kafka.Client(),
    producer = new Producer(client),
    Consumer = kafka.Consumer
    

    
/// ->> Check script usage
if(process.argv[2] == "" || process.argv[2] == null || process.argv[3] == "" || process.argv[3] == null){
   logger.info("USAGE: node chat.js <port> <queue>")
   process.exit(1)
}

/// ->> Assign server port and queue
var serv_port = process.argv[2]
var online_queue = process.argv[3]

var socktable = { }
var arrSocktable = {}

//System can duplicate login
var isCanDuplicateLogin = true

app.use(bodyParser());
app.use(bodyParser.urlencoded({ extended: false }))

/// ->> check request body, if it is not JSON then return error
app.use(function (error,req, res, next) {
   var hrstart = process.hrtime();
   if(error){
      logger.error(error)
      var respData = {"code" : "73003"}
      sendResponse("null",res,error.body,respData,hrstart,"http")
      //res.send("ERRORRRRR")
      return
   }
   next()
});

/// ->> Waiting for POST request from http
app.all('/', function(req, res){
   logger.info('User connected, ip: ',req.connection.remoteAddress)
	 var hrstart = process.hrtime()
   var now = new Date()
     , inid =now.format('YYMMDDhhmmssSS') // process.pid+""+
     , datetimeformat = now.format('YYYY-MM-DD hh:mm:ss')
     , datetimeformat2 = now.format('YYYYMMDDhhmmssSS')
     , raw_jsonObj = req.body
     , retData = { "code": 0, "data":{}}
     , channel = "http"

   prtlog(inid,"info","Raw request : "+JSON.stringify(raw_jsonObj))
   
   /// ->> validate request format for every command
   var validate = validateRequest(inid,raw_jsonObj)
   if(validate.code != 0){
      /// ->> if invalid, send back failed 
      var respData = validate
      sendResponse(inid,res,raw_jsonObj,respData,hrstart,channel) 
      return
   }
   
   uid = raw_jsonObj.fromsubscriberid
   var resp_message = raw_jsonObj
   
   /// ->> create message id for a request
   var messageid = new ObjectID() 
   
   /// ->> process command 
   if(raw_jsonObj.cmd == "noti"){
      if(["addWishlist","reqGroup","joinGroup","kickGroupMB","denyGroup","leaveGroup","inviteFriend","rejectFriend","acceptFriend"].indexOf(raw_jsonObj.type) > -1){
         logger.info(raw_jsonObj.tosubscriberid)
         noti(inid,res,raw_jsonObj,hrstart,channel)(function(respData){
         })
      }else if(raw_jsonObj.type == "disconnect"){
      	 logger.info("DISCONNECT ",raw_jsonObj)
      	 notiDisconnect(inid,res,raw_jsonObj,hrstart,channel)(function(respData){
         })
      }else{
         respData = {"code" : "70004"}
         sendResponse(inid,res,raw_jsonObj,respData,hrstart,channel)
      }
   }else if(raw_jsonObj.cmd == "chat"){
      if(["transfer","sendPointGift","sendGift","sendThank","IWantThis"].indexOf(raw_jsonObj.type) > -1){
         chat(inid,res,uid,raw_jsonObj,hrstart,channel,null)(function(respData){
         })
      }else{
         respData = {"code" : "70004"}
         sendResponse(inid,res,raw_jsonObj,respData,hrstart,channel)
      }
   }else if(raw_jsonObj.cmd == "STOPSERV"){
      respData = {"code" : "0", "data":{"description":"STOP SERVER SUCCESS"}}
      sendResponse(inid,res,mainbody,respData,hrstart,channel)
      http.close()
      mgs_chat_mod.db.close()
      mgs_mod.db.close()
      return
   }else{
      logger.info(">%d< command does not exist: ",inid,raw_jsonObj.cmd)
      respData = {"code" : "70004"}
      sendResponse(inid,res,raw_jsonObj,respData,hrstart,channel)
      return
   }
   //res.end()
})

/// ->> Waiting for request from web socket
wss.on('connection', function connection(ws) {
   var location = url.parse(ws.upgradeReq.url, true);
   //var ipaddress = ws.upgradeReq.connection.remoteAddress
   var strIpAddress = ws.upgradeReq.headers['x-forwarded-for']
   
   console.log(ws.upgradeReq.headers['x-forwarded-for'])
   var Registerflag = false
     , forceDisConnflag = false
     , uid
     , registerd_uid
     , channel = "socket"
       
   logger.info('User connected, ip: ',strIpAddress)
   
   /// ->> Process when message event is coming
   ws.on('message', function incoming(msg) {
      var hrstart = process.hrtime();
      var respData = {"code": 0, "data": {} }
      var now = new Date()
      var inid =now.format('YYMMDDhhmmssSS'), // process.pid+""+
          datetimeformat = now.format('YYYY-MM-DD hh:mm:ss'),
          datetimeformat2 = now.format('YYYYMMDDhhmmssSS')
      var raw_jsonObj

      try {
         raw_jsonObj = JSON.parse(msg)
      } catch (error) {    
         var respData = {"code" : "73003"}
         prtlog(inid,"error",error)
         sendResponse("null",ws,msg,respData,hrstart,channel)
         return
      }
      
      prtlog(inid,"info","Raw request : "+JSON.stringify(raw_jsonObj))
      var validate = validateRequest(inid,raw_jsonObj)
      if(validate.code != 0){
         var respData = validate
         sendResponse(inid,ws,raw_jsonObj,respData,hrstart,channel) 
         return
      }
      // process response from client
      if(raw_jsonObj.cmd.indexOf("resp_") > -1){
         if(raw_jsonObj.cmd.indexOf("resp_") == 0){
         	  //separate indi and group
            // process
            logger.info("++++++++RESPONSE CMD")
            if(raw_jsonObj.type == "read"  ){
               //logger.info("+++++++++++++++ read 0 ",data)
               if(raw_jsonObj.resp_code == 0){
                  mgs_chat_mod.chat.findOne({"_id": raw_jsonObj.messageid,"tosubscriberid":{ "$elemMatch" : { "subscriberid" : registerd_uid, "read": true} }})
                  .lean()
                  .exec(function (error, data) {
                     if(data.gid == null){
                        var queryval = {"_id": {"$lte": raw_jsonObj.messageid}, 
                     	                 "sendreadtosender":false,
   	                                    "tosubscriberid":{ "$elemMatch" : { "subscriberid" : registerd_uid, "read": true} },
   	                                    "fromsubscriberid": data.fromsubscriberid}
                     }else{
                        var queryval = {"_id": {"$lte": raw_jsonObj.messageid}, 
                     	                 "sendreadtosender":false,
                     	                 "gid": data.gid,
   	                                    "tosubscriberid":{ "$elemMatch" : { "subscriberid" : registerd_uid, "read": true} },
   	                                    "fromsubscriberid": data.fromsubscriberid}
                     }
                     
                     mgs_chat_mod.chat.update(queryval,{$set: {"sendreadtosender":true}},{multi: true})                                           
                     .lean()
                     .exec(function (error, result) {
                        return
                     })
                  })
               }else{
                  return
               }
               
            }
            
            
            var setvalue = {"$set": {"tosubscriberid.$.sent":false, "tosubscriberid.$.sent_dtm":datetimeformat}}
            if(raw_jsonObj.resp_code == 0){
               //update sent in db
               setvalue = {"$set": {"tosubscriberid.$.sent":true, "tosubscriberid.$.sent_dtm":datetimeformat}}
            }else if(raw_jsonObj.resp_code == 1){
               if(raw_jsonObj.cmd == "resp_chat" ){
                  if(raw_jsonObj.type == "indi" ||raw_jsonObj.type ==  "group"){
                     setvalue = {"$set": {"tosubscriberid.$.sent":true, "tosubscriberid.$.sent_dtm":datetimeformat}}
                  }
               }
            }
            
            mgs_chat_mod.chat.findOne({"_id": raw_jsonObj.messageid})
            .lean()
            .exec(function (error, chatdata) {    
               mgs_chat_mod.chat.update({"_id":raw_jsonObj.messageid, "tosubscriberid" : { "$elemMatch" : { "subscriberid" : registerd_uid, "sent": false} }},setvalue)
               .lean()
               .exec(function (error, data) {
                  logger.info(data)
                  if(raw_jsonObj.resp_code == 1 && raw_jsonObj.cmd == "resp_chat"){
                     if(raw_jsonObj.type == "indi" ||raw_jsonObj.type ==  "group"){   //separate indi and group
                        
                        var make_read = {
                                          "trx": raw_jsonObj.trx,
                                          "cmd": 'chat',
                                          "dtm": datetimeformat2,
                                          "type": "read",
                                          "messageid": raw_jsonObj.messageid,
                                          "tosubscriberid": chatdata.fromsubscriberid
                                        }
                        //logger.info("+++++++++ MAKE READ ",make_read)
                        read(inid,null,registerd_uid ,make_read,process.hrtime(),channel,ws)(function(respData){
                           //return
                        })
                     }
                     
                  }
               })
            })
            return
            
         }else{
            //send failed ??
            return
         }
      }

      // Check incoming Token with registered token
      if(arrSocktable[registerd_uid]){
         //logger.info(raw_jsonObj.cmd+" "+socktable[registerd_uid].registerflag+" "+socktable[registerd_uid].token_no+" "+raw_jsonObj.token_no)
         //if(raw_jsonObj.cmd != "register" && socktable[registerd_uid].registerflag && socktable[registerd_uid].token_no != raw_jsonObj.token_no){
         
         /*
         if(arrSocktable[registerd_uid].ws.myFind({"token_no": raw_jsonObj.token_no}).length == 0  && raw_jsonObj.cmd != "register"){ 
            if(raw_jsonObj.type == "indi" || raw_jsonObj.type == "group"){
               respData.code = "70018"
               sendResponse(inid,ws,raw_jsonObj,respData,hrstart,channel) 
               return
            }else{
               raw_jsonObj.token_no = "temp_token_for_serverchatcommand"
            }
            //send response 
         }*/
         
         if(arrSocktable[registerd_uid].ws.length < 1){
            respData.code = 78888
            sendResponse(inid,ws,raw_jsonObj,respData,hrstart,channel) 
            return
         }
      }else{
         if(raw_jsonObj.cmd != "register"){
            respData.code = 78888
            sendResponse(inid,ws,raw_jsonObj,respData,hrstart,channel) 
            return
         }
      }
      
      // process request from client
      authen_mod.newCheckToken(mgs_mod,inid,raw_jsonObj.token_no)(function(respData){
         logger.info("DEBUG +++++++ token ",respData)
         if(respData.code != "0" && respData.code != 0){
            //if(raw_jsonObj.type == "sendGift" || raw_jsonObj.type == "transfer" || raw_jsonObj.type == "sendPointGift" || raw_jsonObj.type == "sendThank" ||raw_jsonObj.type == "IWantThis" ){
            //   uid = raw_jsonObj.fromsubscriberid
            //}else{
               sendResponse(inid,ws,raw_jsonObj,respData,hrstart,channel) 
               return
            //}            
         }else{
            uid = respData.data.usrid
         }
        
         if(raw_jsonObj.cmd == "register"){
            register(inid,uid,ws,raw_jsonObj,strIpAddress)(function(result){
               //register_token = raw_jsonObj.token ///// NEED TO CHECK++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
               if(result.code == 0){
                  registerd_uid = uid
                  var isNeedNoti = result.data.isNeedNoti
                  delete result.data.isNeedNoti
                  sendResponse(inid,ws,raw_jsonObj,result,hrstart,channel)
                  //send noti to all friend
                  if(isNeedNoti){
                     preNotiUserOnlineOffline(mgs_mod,inid,uid,0)(function(respData){
                        logger.info(">%d< online notify to all friends for uid : ",inid,uid)
                     })
                  }
                  
               }else{
                  sendResponse(inid,ws,raw_jsonObj,result,hrstart,channel)
               }        
            })
         }else if(raw_jsonObj.cmd == "chat"){
            ///if(raw_jsonObj.type == "read"){
            ///   read(inid,ws,uid ,raw_jsonObj,hrstart,channel)(function(respData){
            ///   })
            ///}else{
               // -->> Check friend status and my status
               subsc_mod.new_checkFriendStatus(mgs_mod,inid,String(uid),raw_jsonObj.tosubscriberid)(function(respData){
                  prtlog(inid,"info","Check friend status id: "+raw_jsonObj.tosubscriberid+", result:"+JSON.stringify(respData))
                  if(respData.code != 0){
                     sendResponse(inid,ws,raw_jsonObj,respData,hrstart,channel) 
                     return
                  }
                  if(raw_jsonObj.type == "sendGift" || raw_jsonObj.type == "transfer" || raw_jsonObj.type == "sendPointGift" ){
                     /*if(respData.data.friendstatus == "D" || respData.data.status == "I" ){
                        var retData = {"data":{}}
                        retData.code = 70010
                        retData.data.description = respData.data
                        sendResponse(inid,ws,raw_jsonObj,retData,hrstart,channel) 
                        return
                     }*/
            	    }else{
            	       logger.info("CHECKKK ",raw_jsonObj.type)
            	       ///// 16/09/2016 comment out
            	       //retData = { "code":0,"data":""}
            	       //sendResponse(inid,ws,raw_jsonObj,retData,hrstart,channel) 
            	       if(respData.data.mystatus != "A" && respData.data.friendstatus != "A"){
                        return
                     }
            	    }
                  if(raw_jsonObj.type == "read"){
                     read(inid,ws,uid ,raw_jsonObj,hrstart,channel,ws)(function(respData){
                     })
                  }else{
                     chat(inid,ws,uid,raw_jsonObj,hrstart,channel,ws)(function(respData){
                     })
                  }
               })
            ///}      
         }else if(raw_jsonObj.cmd == "request"){
            if(raw_jsonObj.type == "clearNoti"){
               clearMessage(inid,uid,"noti")(function(result){
                  sendResponse(inid,ws,raw_jsonObj,result,hrstart,channel) 
               })
            }else if(raw_jsonObj.type == "clearMessage"){
               var gid,
                   friendid
               if(raw_jsonObj.gid){
                  gid = raw_jsonObj.gid
                  friendid = null
               }else if(raw_jsonObj.friendid){
                  gid = null
                  friendid = raw_jsonObj.friendid
               }
               clearMessage(inid,uid,gid,friendid,"chat")(function(result){
                  sendResponse(inid,ws,raw_jsonObj,result,hrstart,channel) 
               })
            }else if(raw_jsonObj.type == "getBacklogMessage"){
               getBacklogMessage(inid,uid,"chat")(function(result){
                  sendResponse(inid,ws,raw_jsonObj,result,hrstart,channel) 
               })
            }else if(raw_jsonObj.type == "getBacklogNoti"){
               getBacklogMessage(inid,uid,"noti")(function(result){
                  sendResponse(inid,ws,raw_jsonObj,result,hrstart,channel) 
               })
            }else if(raw_jsonObj.type == "getLastClearMsgid"){
               getLastClearMsgid(inid,uid,raw_jsonObj.friendid)(function(result){
                  sendResponse(inid,ws,raw_jsonObj,result,hrstart,channel) 
               })
            }
         }
      }) 
   });
   
   /// ->> Process when user disconnect
   ws.on('close', function(reasonCode, description) {      
      var retData = { "code": 0, "data":{}}
      var hrstart = process.hrtime();
      var now = new Date()
        , inid =now.format('YYMMDDhhmmssSS') // process.pid+""+
        , datetimeformat = now.format('YYYY-MM-DD hh:mm:ss')
        , datetimeformat2 = now.format('YYYYMMDDhhmmssSS')
         	
      //logger.info(">%d< uid: %s disconnect",inid,uid)
      prtlog(inid,"info","uid: "+uid+" disconnected, ip: "+strIpAddress)
      logger.info(">>>>>>>>>>>>>>>>>>>>>>>>>>>> reasonCode ", reasonCode)
      
      /// ->> Check if uid is in socket table
      if(arrSocktable[uid]){
         
         /// ->> Check if Disconnect by same server
         if(reasonCode == 4000){ 
            //socktable[uid].forceDisConnflag = false	
            
         /// ->> Check if Disconnect by rabbit (other server)
         }else if(reasonCode == 4001){
            /// ->> delete uid from socket table
            /*
            arrSocktable[uid].ws.forEach(function(onews, wsindex){
               if(onews.ws == ws){
                  //remove socket in socket table
                  //logger.info("SAMEEEEEEEEEEEE ",wsindex)
                  arrSocktable[uid].ws.splice(wsindex, 1)
               }
            })*/
            
         /// ->> Check if Disconnect by user
         }else{
            var strDeviceTypeClose
            //remove ws
            arrSocktable[uid].ws.forEach(function(onews, wsindex){
               if(onews.ws == ws){
                  //remove socket in socket table
                  //logger.info("SAMEEEEEEEEEEEE ",wsindex)
                  strDeviceTypeClose = arrSocktable[uid].ws[wsindex].devicetype
                  arrSocktable[uid].ws.splice(wsindex, 1)
                  
               }
            })
            
            // Check if there are another sockets from the same user which has registerd in the same applicaiton
            if(arrSocktable[uid].ws.length >0){
               // don't remove queue in db
            }else{
     
               mgs_mod.newtoken.findOne({"doctype":"doctoken", "subscriberid":uid}, function(error,data){
                  if(error){
                     return
                  }
                  if(data){
                     data.token[strDeviceTypeClose].online.forEach(function(onequeue, qindex){
                        if(onequeue.queue == online_queue){
                           logger.info("found q index ",qindex)
                           data.token[strDeviceTypeClose].online.splice(qindex, 1)
                        }
                     })
                     data.save()
                     logger.info("DEBUG DATA ",data.token[strDeviceTypeClose].online)
                     if(data.token.web.online.length == 0 && data.token.app.online.length == 0){
                        preNotiUserOnlineOffline(mgs_mod,inid,uid,1)(function(respData){
                           //prtSummary(inid,raw_jsonObj,process.hrtime(hrstart),"MSG")
                           logger.info(">%d< offline notify to all friends for uid : ",inid,uid)
                        })
                     }
                  }
                  
                  
               })
            }
            
            
            
            /*
            if(arrSocktable[uid].ws.myFind({"ws":ws}).length >0){
               var s = arrSocktable[uid].ws.myFind({"ws":ws})
               logger.info("FOunddddddddddddd <<  ", arrSocktable[uid].ws.indexOf())
            }*/
            //{"$pull":{"wishlist":{"stockitemid" : raw_jsonObj.stockitemid}}}
            //mgs_mod.newtoken.update({"doctype":"doctoken", "subscriberid":uid},{"$pull":{"wishlist":{"stockitemid" : raw_jsonObj.stockitemid}}})
            
            /*
            /// ->> Clear field online_queue in db and delete uid from socket table
            subsc_mod.updSubscData(mgs_mod,inid,uid,{'doctype':'docsubscriber', '_id': uid},{$set:{"online_queue.queue":"", "online_queue.updatedate":datetimeformat}},{upsert:true})(function(respData){     
               delete socktable[uid]
               
               logger.info(">%d< Clear online_queue value uid: ",inid,uid)
               preNotiUserOnlineOffline(mgs_mod,inid,uid,1)(function(respData){
                  //prtSummary(inid,raw_jsonObj,process.hrtime(hrstart),"MSG")
                  logger.info(">%d< offline notify to all friends for uid : ",inid,uid)
               })
            },function (err) {
               logger.error(">%d< internal error "+err,inid)
            });*/
         }	
      }
   }); 
});

/// Need to modify
/// ->> Start server listener
server.listen(serv_port, function () { 
	 logger.info('Listening on ' + server.address().port) 
	
	 /// ->> kafka create producer and consumer
   producer.on('ready', function () {
      producer.createTopics([online_queue], true, function (err, data) { 
         if(err){
            //error to start kafka topic 
            //Stop server!!
            logger.info(err)
         }
         var consumer = new Consumer(
            client,[{ topic: online_queue, partition: 0 }],{} //autoCommit: true
         )
         consumer.on('message', function (msg) {
            console.log(msg);
            var hrstart = process.hrtime();
            var now = new Date()
            , inid =now.format('YYMMDDhhmmssSS') // process.pid+""+
            , datetimeformat = now.format('YYYY-MM-DD hh:mm:ss')
            , datetimeformat2 = now.format('YYYYMMDDhhmmssSS')
            
            if (msg) {
              logger.info(">%d< KAFKA RECEIVE: ",inid,msg)
              try {
                 var objKafkaReq = JSON.parse(msg.value)
                 sendMessageForKafkaConsumer(inid,objKafkaReq)(function(respData){
                    logger.info(respData)
                 })
              }catch (err) {
                 // Handle the error here.
                 logger.info(err)
              }  
            } 
         });
      });
   });
   /// ->> Create channel to be receiver for rabbitMQ
   /*
  open.then(function(conn) {
     var ok = conn.createChannel();
     ok = ok.then(function(ch) {
        ch.assertQueue(online_queue);
        ch.consume(online_queue, function(msg) {
        	
           var hrstart = process.hrtime();
           var now = new Date()
             , inid =now.format('YYMMDDhhmmssSS') // process.pid+""+
             , datetimeformat = now.format('YYYY-MM-DD hh:mm:ss')
             , datetimeformat2 = now.format('YYYYMMDDhhmmssSS')
           
           /// ->> Check if there is message
           if (msg !== null) {
              // add try
              var data = JSON.parse(msg.content.toString())
              
              logger.info(">%d< RBMQ RECEIVE: ",inid,msg.content.toString())
              
              /// ->> Check if it is disconnect cmd from other server
              if(data.cmd == "disconnect"){
                 var disconnect_resp = conf.def_disconnect_template
                 var uid = data.uid
                 logger.info(">%d< cmd: ",inid,data.cmd)
                 if(socktable[uid]){
                    if(socktable[uid].ws){
                       prtlog(inid,"info","Duplicate register, force disconnect : "+socktable[uid].ws)
                       
                       respData = {"code": 70007, "data": "" }
                       var disconnect_msg = { "trx": inid,
                                "cmd": "disconnect",
                                "dtm": datetimeformat2,
                                "uid": uid,
                                "ref" :  msg.trx,
                                "from": online_queue} 
                       // send disconnect message
                       socktable[uid].ws.send(JSON.stringify(disconnect_msg))
                 
                       socktable[uid].forceDisConnflag = true
                       socktable[uid].ws.close(4001)
                    }
                 }
              }else if(data.cmd == "chat" ||data.cmd == "noti" ){
                 var uid = data.tosubscriberid
                 if(socktable[uid]){
                    if(socktable[uid].ws){
                       //***** => Change to send to multiple socket
                       logger.info("+++++++++++Rabbit Send : ",data)
                       socktable[uid].ws.send(JSON.stringify(data))
                    }
                 }else{ logger.info(">%d< uid: %s, doesn't online in this server. Data was stored in db.",inid,uid)}
              }

              ch.ack(msg);
           }
        });
     });
     return ok;
  })*/


});

function prtlog(inid,lv,content){
   if(lv=="info"){
      logger.info(">%d< ",inid,content)
   }else if(lv=="debug"){
      logger.debug(">%d< ",inid,content)
   }else if(lv=="error"){
      logger.error(">%d< ",inid,content)
   }else if(lv=="trace"){
      logger.info(">%d< ",inid,content)
   }   
}

// Finish 13/09/2016
// Modify 14/09/2016 isNeedNoti
function register(inid,uid,ws,raw_jsonObj,strIpAddress){ return function(callback, errback) {
   var hrstart = process.hrtime();
   var retData = {"code": 0, "data": {} }
   var now = new Date()
   //var new_inid =now.format('YYMMDDhhmmssSS'), // process.pid+""+
   var datetimeformat = now.format('YYYY-MM-DD hh:mm:ss'),
       datetimeformat2 = now.format('YYYYMMDDhhmmssSS')
   var channel = "socket"
   var disconnect_resp = conf.def_disconnect_template  
   
   //check uid is online in the same server
   logger.debug("++++++++ socket table uid: ",uid)
   logger.debug(">>>>>>>> new socket table: ",arrSocktable	)

   //check uid is online in the other server
   mgs_mod.newtoken.findOne({"doctype":"doctoken", "subscriberid":uid}, function(error,data){
      
      var devicetype = raw_jsonObj.devicetype
      prtlog(inid,"info","Found online queue :"+data.token[devicetype]["online"])
      
      //check if client has login to system before
      if(data.token[devicetype].online.length >0){
      	 //logger.info(data.token[devicetype].online.myFind({"queue":online_queue}))
      	 
      	 //check if same IP
      	 if(data.token[devicetype].ip == strIpAddress && data.token[devicetype].deviceid == raw_jsonObj.deviceid){
      	    //isDuplicate is used to check for send online offline noti
      	    retData.data.isNeedNoti = false
      	    if(data.token[devicetype].online.myFind({"queue":online_queue}).length >0){
               prtlog(inid,"info","Client has registered to system before, with the same queue")
               //Do Nothing
            }else{
               prtlog(inid,"info","Client has registered to system before, with the different queue")
               //Push new queue
               data.token[devicetype].online.push({"queue":online_queue,"updatedate":datetimeformat})
            }
      	 }else{ //different ip and device id
      	    errcode = 70020
            retData.code = errcode
            retData.data = "Token is used by the others, Please re-login."
            
            callback(retData)
            return
      	 }
         
      }else{
         retData.data.isNeedNoti = true
      	 prtlog(inid,"info","Client has not registered to system before")
         data.token[devicetype].online.push({"queue":online_queue,"updatedate":datetimeformat})
         //Push new queue 
      }
      
      data.save(function(error,result){
         if(error){
            //sendResponse(res,"FAILED")
            errcode = 77777
            retData.code = errcode
            retData.data = "Can't update online queue in database"
            sendResponse(inid,res,raw_jsonObj,retData,hrstart,channel)
            callback(retData)
            return
         }
         
         // check user has regiserd in the system before
         if(arrSocktable[uid]){
            if(devicetype == "web"){
               if(isCanDuplicateLogin){
                  //push socket
                  if(Array.isArray(arrSocktable[uid].ws)){
                     arrSocktable[uid].ws.push({"ws":ws,"dtm":datetimeformat, "token_no": raw_jsonObj.token_no, "devicetype" :raw_jsonObj.devicetype})
                  }else{
                     arrSocktable[uid].ws = [{"ws":ws,"dtm":datetimeformat, "token_no": raw_jsonObj.token_no, "devicetype" :raw_jsonObj.devicetype}]
                  }
               }else{
                  //replace socket
                  arrSocktable[uid].ws = [{"ws":ws,"dtm":datetimeformat, "token_no": raw_jsonObj.token_no, "devicetype" :raw_jsonObj.devicetype}]
               }
            }else{ // app
               //replace socket
               arrSocktable[uid].ws = [{"ws":ws,"dtm":datetimeformat, "token_no": raw_jsonObj.token_no, "devicetype" :raw_jsonObj.devicetype}]
            }
         
         }else{
            arrSocktable[uid] = { "ws" : [{"ws":ws,"dtm":datetimeformat, "token_no": raw_jsonObj.token_no, "devicetype" :raw_jsonObj.devicetype}]}
         }
         
         callback(retData)
      })
      
      /*
      //var oldqueue = data.online_queue.queue
      
      //Can duplicate register
      if(isCanDuplicateLogin){
         if(arrSocktable[uid]){
            //push socket
            arrSocktable[uid].ws.push({"ws":ws,"dtm":datetimeformat, "token_no": raw_jsonObj.token_no})
         }else{
            arrSocktable[uid] = { "ws" : [{"ws":ws,"dtm":datetimeformat, "token_no": raw_jsonObj.token_no}]}
         }
      }else{
      	 //send disconnect to old session
      }*/
      
      /*
      if(data.online_queue.queue != "" && data.online_queue.queue != online_queue){
         logger.info(">%d< Send disconnect data uid: %s, into queue:",inid,uid,data.online_queue.queue)
         // ADD to rabbit queue
         var disconnect_msg = { "trx": inid,
                  "cmd": "disconnect",
                  "dtm": datetimeformat2,
                  "uid": uid,
                  "ref" :  raw_jsonObj.trx,
                  "from": online_queue}
         logger.info(" disconnect msg : ",disconnect_msg)
         
         open.then(function(conn) {
            var ok = conn.createChannel();
            ok = ok.then(function(ch) {
               ch.assertQueue(oldqueue);
               ch.sendToQueue(oldqueue, new Buffer(JSON.stringify(disconnect_msg)));
            });
            //return ok; 
         })
      }
      */
      
      //socktable[uid] = { "ws" : ws, "token_no": raw_jsonObj.token_no, "dtm":datetimeformat, "forceDisConnflag":false, "registerflag":true}
      //arrSocktable[uid] = { "ws" : [{"ws":ws,"dtm":datetimeformat, "token_no": raw_jsonObj.token_no}]
      /* 
      data.online_queue.queue = online_queue
      data.online_queue.updatedate = datetimeformat
      data.save()*/
      //callback(retData)
   })
}}

//sendMessage
function chat(inid,res,uid,raw_jsonObj,hrstart,channel,wsocket) { return function(callback, errback) {
	 var retData = { "code": 0, "data":{}} ,
       errcode = '70006'
	 var now = new Date(),
       datetimeformat = now.format('YYYY-MM-DD hh:mm:ss'),
       datetimeformat2 = now.format('YYYYMMDDhhmmssSS')
  
   var member = [] 
   var resp_message = raw_jsonObj
   var messageid = new ObjectID()
   var subdata = {"subscriberid": "",
                  "sent":false,
                  "sent_dtm": "",
                  "read":false,
                  "read_dtm" :"",
                  "clear":false,
                  "clear_dtm":"" 
                 }	
   var chattemplate = {  "_id": messageid,
                         "doctype": "docmessage",
                         "type": null,
                         "trx": raw_jsonObj.trx,
                         "gid" : null,
                         "dtm" : datetimeformat,
                         "fromsubscriberid": uid,
                         "sendreadtosender": true,
                         "clear":false,
                         "tosubscriberid": [],
                         "data": raw_jsonObj.data,
                         "totalread":0
                      }
 
   var calls = [] 
   if(raw_jsonObj.cmd == "chat"){ // type : indi/group
      if(raw_jsonObj.type == "indi" ){
         member.push(raw_jsonObj.tosubscriberid)
         member.push(uid)
         chattemplate.type = raw_jsonObj.type 
         calls.push(function(callback) {
            subdata.subscriberid = raw_jsonObj.tosubscriberid
            chattemplate.tosubscriberid.push(subdata)               	
            callback()
         })
      }else if(raw_jsonObj.type == "sendGift" || raw_jsonObj.type == "transfer" || raw_jsonObj.type == "sendPointGift" || raw_jsonObj.type == "sendThank" ||raw_jsonObj.type == "IWantThis"){  
         //member.push(raw_jsonObj.tosubscriberid)
         //member.push(raw_jsonObj.fromsubscriberid)
         logger.info("CHAT TRANSACTION")
         member = [ raw_jsonObj.fromsubscriberid, raw_jsonObj.tosubscriberid]
         chattemplate.type = raw_jsonObj.type 

         var sub1 = {"subscriberid": raw_jsonObj.tosubscriberid,
                  "sent":false,
                  "sent_dtm": "",
                  "read":false,
                  "read_dtm" :"",
                  "clear":false,
                  "clear_dtm":"" 
                 }	
         var sub2 = {"subscriberid": raw_jsonObj.fromsubscriberid,
                  "sent":false,
                  "sent_dtm": "",
                  "read":false,
                  "read_dtm" :"",
                  "clear":false,
                  "clear_dtm":"" 
                 }	

         chattemplate.tosubscriberid = [ sub1 , sub2 ]
         logger.info("++++++++++++++++++",chattemplate.tosubscriberid)
         
      }else if(raw_jsonObj.type == "group"){
         logger.info(">%d< groupchat id: ",inid,raw_jsonObj.gid)
         //find member by group id
         member = [ "5653e85065f2998d20e2a45a","55e5518565f299b80fbf834b" ]
         chattemplate.type = "group"
         chattemplate.gid = raw_jsonObj.gid
         
         member.forEach(function(onememberid){
            calls.push(function(callback) {
               subdata.subscriberid = onememberid
               chattemplate.tosubscriberid.push(subdata)               	
               callback()
            })
         })   
      //}else if(raw_jsonObj.type == "reqGroup" || raw_jsonObj.type == "joinGroup" || raw_jsonObj.type == "kickGroupMB" ||raw_jsonObj.type == "denyGroup" ||raw_jsonObj.type == "leaveGroup"){
      	   
      }else{ //chat type != indi, group
         //return failed
         errcode = 77777          
         retData.code = errcode
         retData.data = conf.errcode[errcode]
         sendResponse(inid,res,raw_jsonObj,retData,hrstart,channel)
         callback(retData)     
         return
      }

      async.parallel(calls, function(error, result) {
         //logger.info(chattemplate.tosubscriberid)
         var indidocmessage = new mgs_chat_mod.chat(chattemplate,{ skipVersioning: { dontVersionMe: true } })
         indidocmessage.save(function (error, fluffy) {
            if (error){
               //sendResponse(res,"FAILED")
               errcode = 77777
               retData.code = errcode
               retData.data = conf.errcode[errcode]
               sendResponse(inid,res,raw_jsonObj,retData,hrstart,channel)
               callback(retData)
               return
            }
            retData.messageid = messageid
            logger.info("******** CHAT retData ", retData)
            sendResponse(inid,res,raw_jsonObj,retData,hrstart,channel)
            
            sendMessage(inid,messageid,uid,member,chattemplate.type,raw_jsonObj,wsocket)(function(respData){
               logger.info("respData ",respData)
               callback(respData)
               prtSummary(inid,raw_jsonObj,process.hrtime(hrstart),"MSG")
            },function (error) {
               logger.error(">%d< internal error "+error,inid)
               errcode = 77777
               retData.code = errcode
               retData.data = conf.errcode[errcode]
               callback(retData)
            });
         });    
      });
   }else{
      logger.info(">%d< command does not exist: ",inid,raw_jsonObj.cmd)
      errcode = 77777          
      retData.code = errcode
      retData.data = conf.errcode[errcode]
      callback(retData)     
      return
   }  
}}

//sendMessage
function read(inid,res,uid,raw_jsonObj,hrstart,channel,wsocket) { return function(callback, errback) {
	 var now = new Date()
   var datetimeformat = now.format('YYYY-MM-DD hh:mm:ss')
   var datetimeformat2 = now.format('YYYYMMDDhhmmssSS')
   var retData = { "code": 0, "data":{}} 
   var errcode = '70006'
   //check if internalflag
   
   //logger.info("++++++++++++++++", raw_jsonObj)
   //logger.info("READDDDDD ",uid,raw_jsonObj.tosubscriberid)
   mgs_chat_mod.chat.findOne({ "_id":raw_jsonObj.messageid,
   	                           "tosubscriberid":{ "$elemMatch" : { "subscriberid" : uid, "read": true} },
   	                           "fromsubscriberid" : raw_jsonObj.tosubscriberid})
   .lean()
   .exec(function (error, dataMessage) {
      //logger.info("************dataMessage : ",dataMessage)
      if(dataMessage){
         prtlog(inid,"info","Message was read before :"+raw_jsonObj.messageid)
         if(res != null){
            sendResponse(inid,res,raw_jsonObj,retData,hrstart,channel)
         }
         retData.data = "Message was read"
         callback(retData)
         prtSummary(inid,raw_jsonObj,process.hrtime(hrstart),"MSG")
         return
      }
      mgs_chat_mod.chat.update({"_id": {"$lte": raw_jsonObj.messageid}, 
      	                        "tosubscriberid":{ "$elemMatch" : { "subscriberid" : uid, "read": false, "sent":true} },
      	                        "fromsubscriberid" : raw_jsonObj.tosubscriberid},
      {$set: {"sendreadtosender":false, "tosubscriberid.$.read":true, "tosubscriberid.$.read_dtm":datetimeformat}, $inc:{"totalread":1}},{multi: true})
      .lean()
      .exec(function (error, result) {
         if(error){
            logger.error(error)
            retData.code = errcode
            retData.data = conf.errcode[errcode]
            sendResponse(inid,res,raw_jsonObj,retData,hrstart,channel)
            callback(retData)
            return
         }
         
         logger.info(">%d< update sendreadtosender: false",inid, result)
         retData.messageid = raw_jsonObj.messageid
         if(res != null){
            sendResponse(inid,res,raw_jsonObj,retData,hrstart,channel)
         }
         var member = [raw_jsonObj.tosubscriberid,uid]
         raw_jsonObj.data = {"totalread":result.totalread, "tosubscriberid": result.tosubscriberid}
         logger.info("++++++++++++++++++++ result ",result)
         sendMessage(inid,raw_jsonObj.messageid,uid,member,raw_jsonObj.type,raw_jsonObj,wsocket)(function(respData){
            callback(respData)
            prtSummary(inid,raw_jsonObj,process.hrtime(hrstart),"MSG")
         },function (error) {
            logger.error(">%d< internal error "+error,inid)
            errcode = 77777
            retData.code = errcode
            retData.data = conf.errcode[errcode]
            callback(retData)
         });
      })
   })
   
   
}}

// sendmessage
function noti(inid,res,raw_jsonObj,hrstart,channel) { return function(callback, errback) {
	 var now = new Date()
   var datetimeformat = now.format('YYYY-MM-DD hh:mm:ss')
   var datetimeformat2 = now.format('YYYYMMDDhhmmssSS')
   var retData = { "code": 0, "data":{}} 
   var errcode = '70006'
   var member = [],
       calls = []
   var messageid = new ObjectID()
   var chattemplate = {  "_id": messageid,
                         "doctype": "docnoti",
                         "trx": raw_jsonObj.trx,
                         "type": null,
                         "gid" : null,
                         "dtm" : datetimeformat,
                         "fromsubscriberid": raw_jsonObj.fromsubscriberid,
                         "sendreadtosender": true,
                         "clear":false,
                         "tosubscriberid": [],
                         "data": raw_jsonObj.data,
                         "totalread":0
                      }
                      
   //logger.info(">%d< find id by token: "+raw_jsonObj.token_no+" ,userid: "+uid,inid)
   logger.info(">%d< Cmd: ",inid,raw_jsonObj.cmd) 
   member = raw_jsonObj.tosubscriberid
   chattemplate.type = raw_jsonObj.type
   //logger.info(raw_jsonObj.tosubscriberid)
   console.log(raw_jsonObj.tosubscriberid)
   member.forEach(function(onememberid){
      calls.push(function(callback) {
         var subdata = {"subscriberid": onememberid,
                  "sent":false,
                  "sent_dtm": "",
                  "read":false,
                  "read_dtm" :"",
                  "clear":false,
                  "clear_dtm":"" 
                 }	
         chattemplate.tosubscriberid.push(subdata)          	
         callback()
      })
   })   
   
   async.parallel(calls, function(error, result) {     
      //logger.info(">>>>",chattemplate)  
      var indidocmessage = new mgs_chat_mod.notimessage(chattemplate,{ skipVersioning: { dontVersionMe: true } })
      indidocmessage.save(function (error, fluffy) {
         if (error){
            errcode = 77777
            retData.code = errcode
            retData.data = conf.errcode[errcode]
            sendResponse(inid,res,raw_jsonObj,retData,hrstart,channel)
            callback(retData)
            return
         }
         retData.messageid = messageid
         if(res != null){
            sendResponse(inid,res,raw_jsonObj,retData,hrstart,channel)
         }
         sendMessage(inid,messageid,raw_jsonObj.fromsubscriberid,member,raw_jsonObj.type,raw_jsonObj,null)(function(respData){
            callback(retData)
            prtSummary(inid,raw_jsonObj,process.hrtime(hrstart),"MSG")
         },function (error) {
            logger.error(">%d< internal error "+error,inid)
            errcode = 77777
            retData.code = errcode
            retData.data = conf.errcode[errcode]
            callback(retData)
         });
      });
   });
}}

function sendMessage(inid,messageid,uid,subscribers,type,req_data,wsocket){ return function(callback, errback) {//type = inid,group  //subscriber = receiver
   var now = new Date()
   var datetimeformat = now.format('YYYY-MM-DD hh:mm:ss')
   var datetimeformat2 = now.format('YYYYMMDDhhmmssSS')
   var calls = []
   var retData = { "code": 0, "data":{}} 
   var errcode = '70008'
   var ackread_flag = false
   //logger.info("++++++++++++++++++++++ ",subscribers)
   subscribers.forEach(function(onememberid){
      calls.push(function(callback) {
         var message = { "trx":req_data.trx,
             "cmd":req_data.cmd,
             "dtm": datetimeformat2,
             "type":type,
             "gid":null,
             "messageid": messageid, //gen by mongo
             "fromsubscriberid":uid,
             "tosubscriberid":onememberid,
             "data": req_data.data
         }
         
         if(type == "group"){
            message.gid = req_data.gid
         }else if(type == "read"){
            message.totalread == req_data.totalread
         }
         
         if(arrSocktable[onememberid]){ //destination is in the same server
            logger.info(arrSocktable[onememberid].ws.length)
            if(arrSocktable[onememberid].ws){ 
               logger.info(">%d< %s Online in the same server ",inid,onememberid)
               logger.info(">%d< Send message to uid: ",inid,onememberid)
               logger.info(">%d< content: ",inid,JSON.stringify(message))
               try{
                  // ***** => change to loop for multiple socket ->> Done
                  //socktable[onememberid].ws.send(JSON.stringify(message))
                  arrSocktable[onememberid].ws.forEach(function(onews){
                     if(wsocket != null){
                        if(wsocket != onews.ws){
                           onews.ws.send(JSON.stringify(message))
                        }
                     }else{
                        onews.ws.send(JSON.stringify(message))
                     }
                  })
                  //callback()
                  //return
               }catch (error) {    
                  var respData = {"code" : "70008"}
                  prtlog(inid,"error",error)
                  //sendResponse(inid,ws,msg,respData,hrstart,channel)
                  //return
                  callback()
                  return
               }
               
            }
         }else{
            logger.info(">%d< %s Not online in the same server ",inid,onememberid)
         }
         
         //logger.info(">%d< %s Not online in the same server ",inid,onememberid)
         // Find user in other queues and send to kafka
         mgs_mod.newtoken.findOne({"doctype":"doctoken", "subscriberid":onememberid}, function(error,data){
            if(data){
               logger.info(data)
               if(data.token.web.online.length > 0 || data.token.app.online.length > 0){
                  //***** => send to kafka queue
                  var arrQueue = []
                  data.token.web.online.forEach(function(onequeue){
                     console.log(onequeue.queue)
                     if(onequeue.queue != online_queue){
                        arrQueue.push(onequeue.queue)
                     }                     
                  })
                  data.token.app.online.forEach(function(onequeue){
                     console.log(onequeue.queue)
                     if(onequeue.queue != online_queue){
                        arrQueue.push(onequeue.queue)
                     }   
                  })
                  
                  var arrUniqQueue = unique(arrQueue)
                  if(arrUniqQueue.length >0){
                     logger.info("+++++++++++ >>> ",arrUniqQueue)
                     kafkaProduce(inid,arrUniqQueue,JSON.stringify(message))(function(result){
                        callback()
                     })
                  }else{
                     callback()
                  }
                  
               }else{
                  logger.info(">%d< Doesn't send message to uid: %s",inid,onememberid)
                  callback()
               }
            }
     
         })
         	
         //check in db
         /*
         mgs_mod.Subsc.findOne({'doctype':'docsubscriber', '_id': onememberid})
         .lean()
         .exec(function (error, data) {
            if(!data.online_queue){
               retData.data = "subscriber is offline"
               logger.info(">%d< Doesn't send message to uid: %s",inid,onememberid)
               callback()
               return
            }
            logger.info(">%d< Found queue: %s",inid,data.online_queue.queue)
            if(data.online_queue.queue != "" && data.online_queue.queue != online_queue){
               logger.info(">%d< Send message to queue:",inid,data.online_queue.queue)
               // ADD to rabbit queue
               open.then(function(conn) {
                  var ok = conn.createChannel();
                  ok = ok.then(function(ch) {
                     ch.assertQueue(data.online_queue.queue);
                     ch.sendToQueue(data.online_queue.queue, new Buffer(JSON.stringify(message)));
                  });
                  callback()
                  //return ok;
               })
            }else{
            	 retData.data = "subscriber is offline"
               logger.info(">%d< Doesn't send message to uid: %s",inid,onememberid)
               callback()
            }
         })            
         */
      })
   })
   
   async.parallel(calls, function(error, result) {
      //retData.data.ackread_flag = ackread_flag
      //logger.info("++++++++++++++++", retData, ackread_flag)
      callback(retData)
      //return //success
   });
}}

function sendMessageForKafkaConsumer(inid,objKafkaReq){ return function(callback, errback) {
   var now = new Date()
   var datetimeformat = now.format('YYYY-MM-DD hh:mm:ss')
   var datetimeformat2 = now.format('YYYYMMDDhhmmssSS')
   var retData = { "code": 0, "data":{}} 
   var errcode = '70008'
   
   var uid = objKafkaReq.tosubscriberid
   logger.info(">%d< cmd: ",inid,objKafkaReq.cmd)
   
   if(arrSocktable[uid]){
      if(arrSocktable[uid].ws){
         logger.info("1")
      	 if(objKafkaReq.type == "disconnect"){
      	    respData = {"code": 70007, "data": "" }
            var disconnect_msg = { "trx": inid,
                     "cmd" : "noti",
                     "dtm" : datetimeformat2,
                     "type" :"disconnect",
                     "uid" : uid,
                     "ref" :  objKafkaReq.trx,
                     "from": online_queue} 
            // send disconnect message
            try{
            	 logger.info("2")
               // ***** => change to loop for multiple socket ->> Done
               arrSocktable[uid].ws.forEach(function(onews, wsindex){
                  onews.ws.send(JSON.stringify(disconnect_msg))
                  arrSocktable[uid].ws[wsindex].forceDisConnflag = true
                  onews.ws.close(4001)
                  logger.info("CLOSEEEE WEBSOCKET")
                  arrSocktable[uid].ws.splice(wsindex, 1)
               })
               callback(retData)
            }catch (error) {    
               //var respData = {"code" : "70008"}
               prtlog(inid,"error",error)
               callback()
               return
            }
      	 }else if(objKafkaReq.cmd == "chat" ||objKafkaReq.cmd == "noti" ){
      	    logger.info("3")
      	    try{
               // ***** => change to loop for multiple socket ->> Done
               arrSocktable[uid].ws.forEach(function(onews, wsindex){
                  onews.ws.send(JSON.stringify(objKafkaReq))
               })
               callback(retData)
            }catch (error) {    
               //var respData = {"code" : "70008"}
               prtlog(inid,"error",error)
               callback()
               return
            }
      	 }  
      }else{ logger.info(">%d< uid: %s, doesn't online in this server. Data was stored in db.",inid,uid)}
   }else{ logger.info(">%d< uid: %s, doesn't online in this server. Data was stored in db.",inid,uid)}

}}

function sendResponse(inid,res,req_data,data,start,type){
	 logger.trace(">%d< send response",inid)
	 var merge_data = null
   var resp_message = conf.def_resp_template
    
   if((typeof req_data) == "object"){
      if(data.code == 0 || data.code == "0"){//
      	 //logger.info(">%d< CODE = 0,"+data.code,inid)
         merge_data = data.data
      }
      resp_message.trx = req_data.trx
      resp_message.cmd = "resp_"+req_data.cmd
      resp_message.type = req_data.type
      resp_message.token_no = req_data.token_no
      resp_message.messageid = data.messageid
      logger.info("*************merge_data ",merge_data)
      if(merge_data != null && merge_data != "" && merge_data != {}){
      	 logger.debug(">%d< Merge object, "+resp_message.trx,inid,data.data)
      	 merge_data.trx = req_data.trx
      	 merge_data.cmd = "resp_"+req_data.cmd
      	 merge_data.token_no = req_data.token_no
      	 merge_data.type = req_data.type
      	 merge_data.messageid = data.messageid
         resp_message = merge_data
      }else{
         resp_message.description = data.data
      }
   }else{
   	  logger.info(">%d< body is not JSON",inid)
   	  resp_message.trx = null
      resp_message.cmd = null
      resp_message.type = null
      resp_message.token_no = null
      resp_message.messageid = null
      resp_message.description = req_data
   }
   
   var now = new Date()
   var df = now.format('YYYYMMDDhhmmss')
   resp_message.dtm = df
   resp_message.res_code = data.code
   resp_message.res_desc = conf.errcode[data.code] 
   var time = process.hrtime(start)
   logger.info(">%d< response: "+JSON.stringify(resp_message),inid)
   /*
   if(type == "http"){
      res.writeHead(200, {'Content-Type': 'text/text'});
      res.write(JSON.stringify(resp_message))
      res.end()
   }else if(type == "socket"){
      res(JSON.stringify(resp_message))
   }*/
   //add try catch
   res.send(JSON.stringify(resp_message))
   
   delete resp_message.reqdata
   
   //logger.info(">%d< [FIN] trx: %s, cmd: %s, token: %s, res_code: %s, desc: %s, ex_time: %ss %sms",
   //                inid,resp_message.trx,req_data.cmd,resp_message.token_no,resp_message.res_code,resp_message.res_desc,time[0],time[1]/1000000)
   resp_message.cmd = req_data.cmd
   prtSummary(inid,resp_message,time,"RESP")
   resp_message = {}
}

function notiDisconnect(inid,res,raw_jsonObj,hrstart,channel) { return function(callback, errback) {
	 var now = new Date()
   var datetimeformat = now.format('YYYY-MM-DD hh:mm:ss')
   var datetimeformat2 = now.format('YYYYMMDDhhmmssSS')
   var retData = { "code": 0, "data":{}} 
   var errcode = '70006'
   var member = [],
       calls = []
   var messageid = new ObjectID()
   var strSubscID = raw_jsonObj.tosubscriberid
   var chattemplate = {  "_id": messageid,
                         "doctype": "docnoti",
                         "trx": raw_jsonObj.trx,
                         "type": raw_jsonObj.type,
                         "gid" : null,
                         "dtm" : datetimeformat,
                         "fromsubscriberid": raw_jsonObj.tosubscriberid,
                         "sendreadtosender": false,
                         "clear":false,
                         "tosubscriberid": [{"subscriberid": strSubscID,
                                             "sent":false,
                                             "sent_dtm": "",
                                             "read":false,
                                             "read_dtm" :"",
                                             "clear":false,
                                             "clear_dtm":"" 
                                            }],
                         "data": raw_jsonObj.data,
                         "totalread":0
                      }
   
   var message = JSON.parse(JSON.stringify(raw_jsonObj))  
   delete message.new_token
   message.messageid = messageid
   logger.info(">%d< Cmd: ",inid,raw_jsonObj.cmd)  
   var indidocmessage = new mgs_chat_mod.notimessage(chattemplate,{ skipVersioning: { dontVersionMe: true } })
   indidocmessage.save(function (error, fluffy) {
      if (error){
         errcode = 77777
         retData.code = errcode
         retData.data = conf.errcode[errcode]
         sendResponse(inid,res,raw_jsonObj,retData,hrstart,channel)
         callback(retData)
         return
      }
      retData.messageid = messageid
      if(res != null){
         sendResponse(inid,res,raw_jsonObj,retData,hrstart,channel)
      }
      
      if(arrSocktable[strSubscID]){ //destination is in the same server
         logger.info(arrSocktable[strSubscID].ws.length)
         if(arrSocktable[strSubscID].ws){ 
            logger.info(">%d< %s Online in the same server ",inid,strSubscID)
            logger.info(">%d< Send message to uid: ",inid,strSubscID)
            logger.info(">%d< content: ",inid,JSON.stringify(message))
            try{
               // ***** => change to loop for multiple socket ->> Done
               //socktable[onememberid].ws.send(JSON.stringify(message))
               arrSocktable[strSubscID].ws.forEach(function(onews){
                  if(raw_jsonObj.new_token != onews.token_no){
                     onews.ws.send(JSON.stringify(message))
                     logger.info("8 CLOSE")
                     onews.ws.close()
                  }
               })
            }catch (error) {    
               var respData = {"code" : "70008"}
               prtlog(inid,"error",error)
               callback()
               return
            }   
         }
      }else{
         logger.info(">%d< %s Not online in the same server ",inid,strSubscID)
      }
      
      mgs_mod.newtoken.findOne({"doctype":"doctoken", "subscriberid":strSubscID}, function(error,data){
         if(error){
            //sendResponse(res,"FAILED")
            errcode = 77777
            retData.code = errcode
            retData.data = conf.errcode[errcode]
            sendResponse(inid,res,raw_jsonObj,retData,hrstart,channel)
            callback(retData)
            return
         }
         logger.info(data)
         if(data){
            logger.info(data)
            if(data.token.web.online.length > 0 || data.token.app.online.length > 0){
               //***** => send to kafka queue
               var arrQueue = []
               data.token.web.online.forEach(function(onequeue){
                  console.log(onequeue.queue)
                  if(onequeue.queue != online_queue){
                     arrQueue.push(onequeue.queue)
                  }                     
               })
               data.token.app.online.forEach(function(onequeue){
                  console.log(onequeue.queue)
                  if(onequeue.queue != online_queue){
                     arrQueue.push(onequeue.queue)
                  }   
               })
               
               var arrUniqQueue = unique(arrQueue)
               if(arrUniqQueue.length >0){
                  logger.info("+++++++++++ >>> ",arrUniqQueue)
                  kafkaProduce(inid,arrUniqQueue,JSON.stringify(message))(function(result){
                     callback(retData)
                  })
               }else{
                  callback(retData)
               }
               
            }else{
               logger.info(">%d< Doesn't send message to uid: %s",inid,strSubscID)
               callback(retData)
            }
         }
      })
   })

}}

function validateRequest(inid,raw_jsonObj) {
   var fieldtemplate
   var retData = { "code": 0, "data":{}} 
   var errcode = "70003"
   if(raw_jsonObj.cmd == "chat"){
      if(raw_jsonObj.type == "indi" || raw_jsonObj.type == "group" ){
         fieldtemplate = "chat"+raw_jsonObj.type
      }else if(raw_jsonObj.type == "read" || raw_jsonObj.type == "sendGift" || raw_jsonObj.type == "transfer" || raw_jsonObj.type == "sendPointGift" || raw_jsonObj.type == "sendThank" ||raw_jsonObj.type == "IWantThis"){
         fieldtemplate = raw_jsonObj.type
      }else{
         //send error
         //logger.error(">%d< Command does't exist: ",inid,raw_jsonObj.cmd)
         prtlog(inid,"error","Command does't exist: "+raw_jsonObj.cmd)
         retData.code = "70004"
         return retData
      }      
   }else if(raw_jsonObj.cmd == "noti"){
      fieldtemplate = raw_jsonObj.type
   }else if(raw_jsonObj.cmd == "register"){
      fieldtemplate = raw_jsonObj.cmd
   }else if(raw_jsonObj.cmd == "request"){
      fieldtemplate = raw_jsonObj.type
   }else if(raw_jsonObj.cmd == "resp_chat" || raw_jsonObj.cmd == "resp_noti"){
   	  fieldtemplate = "response"
   }else{
      prtlog(inid,"error","Command does't exist: "+raw_jsonObj.cmd)
      retData.code = "70004"
      return retData
      
   }
   // add try
   var validate = validator({
     required: true,
     type: 'object',
     properties: fieldconf[fieldtemplate]
   },{
     greedy: true
   })
   //logger.info(">%d< validate json schema: %s, description: %s",inid,validate(raw_jsonObj),JSON.stringify(validate.errors))
   prtlog(inid,"info","validate json schema: "+validate(raw_jsonObj)+", description: "+JSON.stringify(validate.errors))
   if(!validate(raw_jsonObj)){
      retData.code = errcode
      retData.data = validate.errors
   }
   return retData
}

function getBacklogMessage(inid,uid,cmd) { return function(callback, errback) {
   var now = new Date()
   var datetimeformat = now.format('YYYY-MM-DD hh:mm:ss')
   var datetimeformat2 = now.format('YYYYMMDDhhmmssSS')
   var calls = [],
       arrResult = []
   var retData = { "code": 0, "data":{}} 
   var errcode = '70008'
   var doctype
   
   if(cmd == "chat"){
      doctype = "docmessage"
   }else if(cmd == "noti"){
      doctype = "docnoti"
   }else{
   	  retData.code = errcode
      callback(retData)
      return
   }
   logger.info("+++++++ uid ",uid)
   mgs_chat_mod.chat.find({"doctype": doctype,$or:[{"fromsubscriberid":uid,"clear":false},{"tosubscriberid" : { "$elemMatch" : { "subscriberid" : uid,"clear":false} }}]})
   //.limit(50)
   .sort({_id: 1})
   .lean()
   .exec(function(error,data){
      //logger.info("+++++++ SEND PENDING ",JSON.stringify(data))

      data.forEach(function(onedata){
         calls.push(function(callback) {
            var build_jsonObj = { "trx": onedata.trx,
                                  "cmd": cmd,
                                  "dtm": onedata.dtm,
                                  "type": onedata.type,
                                  "fromsubscriberid": onedata.fromsubscriberid,
                                  "tosubsciberid":onedata.tosubscriberid,
                                  "messageid" : onedata._id,
                                  "totalread": onedata.totalread,
                                  "data": onedata.data
                                }
            arrResult.push(build_jsonObj)
            callback()
         })
      })
      
      async.series(calls, function(error, result) {
         //logger.info("+++++++++++++++++++++++",arrResult)
         if(cmd == "chat"){
            retData.data.backlogmessage = arrResult
         }else if(cmd == "noti"){
            retData.data.backlognoti = arrResult
         }
        
         callback(retData)
      })  

   })

}}

function clearMessage(inid,uid,gid,friendid,cmd) { return function(callback, errback) {
   var now = new Date()
   var datetimeformat = now.format('YYYY-MM-DD hh:mm:ss')
   var datetimeformat2 = now.format('YYYYMMDDhhmmssSS')
   var calls = []
   var retData = { "code": 0, "data":{}} 
   var errcode = '70008'
   var doctype,
       query1 = {},
       query2 = {}
   
   if(cmd == "chat"){
      doctype = "docmessage"
   }else if(cmd == "noti"){
      doctype = "docnoti"
   }else{
   	  retData.code = errcode
      callback(retData)
      return
   }
   
   if(gid){
      query1 = {"doctype": doctype,"fromsubscriberid":uid,"gid":gid,"clear":false}
      query2 = {"doctype": doctype,"gid":gid,"tosubscriberid" : { "$elemMatch" : { "subscriberid" : uid,"clear":false} }}
   }else if(friendid){
      query1 = {"doctype": doctype, "fromsubscriberid":uid, "gid":null, "clear":false, "tosubscriberid" : { "$elemMatch" : { "subscriberid" : friendid} }}
      query2 = {"doctype": doctype,"gid":null,"fromsubscriberid":friendid, "tosubscriberid" : { "$elemMatch" : { "subscriberid" : uid,"clear":false} }}
   }
   
   calls.push(function(callback) {
      //mgs_chat_mod.chat.update({"doctype": doctype,"fromsubscriberid":uid,"clear":false},{"$set":{"clear":true}},{multi: true})
      mgs_chat_mod.chat.update(query1,{"$set":{"clear":true}},{multi: true})
      .lean()
      .exec(function(error,data){
         logger.info(data)
         callback()
      })
   })
   
   calls.push(function(callback) {
      //mgs_chat_mod.chat.update({"doctype": doctype,"tosubscriberid" : { "$elemMatch" : { "subscriberid" : uid,"clear":false} }},
      //                         {"$set":{"tosubscriberid.$.clear":true, "tosubscriberid.$.clear_dtm":datetimeformat}},{multi: true})
      mgs_chat_mod.chat.update(query2,
                               {"$set":{"tosubscriberid.$.clear":true, "tosubscriberid.$.clear_dtm":datetimeformat}},{multi: true})                         
      .lean()
      .exec(function(error,data){
         logger.info(data)
         callback()
      })
   })
   
   async.parallel(calls, function(error, result) {
      callback(retData)
   })   
}}

function getLastClearMsgid(inid,uid,friendid) { return function(callback, errback) {
   var retData = { "code": 0, "data":{}} 
   mgs_chat_mod.chat.findOne({"doctype": "docmessage",$or:[{"fromsubscriberid":uid,"clear":true, "tosubscriberid" : { "$elemMatch" : { "subscriberid" : friendid} }},{"fromsubscriberid":friendid,"tosubscriberid" : { "$elemMatch" : { "subscriberid" : uid, "clear":true} }}]})
   .sort({_id: -1})
   .lean()
   .exec(function(error,data){
      if(data){
         retData.data.messageid = data._id
      }
      callback(retData)
   })
}}

function prtSummary(inid,resp_message,time,action){
   if(action == "MSG"){
      logger.info(">%d< [FIN-MSG] trx: %s, cmd: %s, token: %s, ex_time: %ss %sms",
                   inid,resp_message.trx,resp_message.cmd,resp_message.token_no,time[0],time[1]/1000000)
   }else if (action == "RESP"){
      logger.info(">%d< [FIN-RESP] trx: %s, cmd: %s, token: %s, res_code: %s, desc: %s, ex_time: %ss %sms",
                   inid,resp_message.trx,resp_message.cmd,resp_message.token_no,resp_message.res_code,resp_message.res_desc,time[0],time[1]/1000000)
   }
   
}

function preNotiUserOnlineOffline(mgs_mod,inid,uid,mode){  return function(callback, errback) { //mode 0 = online, 1 = offline
   var hrstart = process.hrtime();
   var now = new Date()
   var datetimeformat = now.format('YYYY-MM-DD hh:mm:ss')
   var datetimeformat2 = now.format('YYYYMMDDhhmmssSS')
   var retData = { "code": 0, "data":{}} 
   var friendidlist = []
   var make_request = { "trx": inid,
                              "cmd": "noti",
                              "dtm": datetimeformat2,
                              "type": "userOnline",
                              "fromsubscriberid": String(uid),
                              "tosubscriberid": [],
                              "data": {
                              }
                            }
   if(mode == 1){
      make_request.type = "userOffline"
   }

   mgs_mod.friend.aggregate([{ $match :{"doctype": "docfriend","subscriberid": String(uid)}},
                                { $limit : 1 },
                                { $unwind: "$friends" },
                                { $match :{"friends.status": "A"}}
                            ])
   .exec(function (error, friendlist) { 
      if(error){
         retData.code = 77777
         callback(retData)
         return
      }
      //console.log(friendlist)
      friendlist.forEach(function(onefriend){
         friendidlist.push(onefriend.friends.subscriberid)
      })
      //console.log(friendidlist)
      if(friendidlist.length > 0){
         make_request.tosubscriberid = friendidlist
         //console.log(make_request)
         noti(inid,null,make_request,hrstart,"")(function(respData){
            callback(respData)
         })
      }else{
         callback(retData)
      }
      
   })
}}

function kafkaProduce(inid,arrQueue,strMessage){  return function(callback, errback) {
   var now = new Date()
   var datetimeformat = now.format('YYYY-MM-DD hh:mm:ss')
   var datetimeformat2 = now.format('YYYYMMDDhhmmssSS')
   var calls = []
   var retData = { "code": 0, "data":{}} 
   var errcode = '70021'
   
   var payloads = [] //[ { topic: 'q9', messages: 'hi', partition: 0 } ];
   logger.info(arrQueue)
   prtlog(inid,"info","Start produce message to Kafka queue: "+arrQueue)
   arrQueue.forEach(function(onequeue){
      logger.info("onequeue ",onequeue)
      payloads.push({ topic: onequeue, messages: strMessage, partition: 0 })
   })
   logger.info(payloads)
   producer.send(payloads, function (error, data) {
         //console.log(data);
         if(error){
            prtlog(inid,"error",error)
            retData.code = errcode
            callback(retData)
            producer.close()
            return
         }
         prtlog(inid,"info","Finish produce message to Kafka queue: "+arrQueue+" "+data)
         callback(retData)
         //producer.close()
         return
      }); 
   /*
   producer.on('ready', function () {
      console.log("READYYYYYYY")
      producer.send(payloads, function (error, data) {
         console.log(data);
         if(error){
            prtlog(inid,"error",error)
            retData.code = errcode
            callback(retData)
            producer.close()
            return
         }
         prtlog(inid,"info","Finish produce message to Kafka queue: "+arrQueue+" "+data)
         callback(retData)
         producer.close()
         return
      }); 
   });  */
}}

Array.prototype.myFind = function(obj) {
   return this.filter(function(item) {
      for (var prop in obj)
         if (!(prop in item) || obj[prop] !== item[prop])
              return false;
      return true;
   });
};