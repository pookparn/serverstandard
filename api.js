////////////////////////////////////////////////////////////////////
/// COMMENT HERE                
/// 
///             
///             
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
if(process.argv[2] == "" || process.argv[2] == null){
   logger.info("USAGE: node chat.js <port> ")
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
   }
})


/// Need to modify
/// ->> Start server listener
server.listen(serv_port, function () { 
	 logger.info('Listening on ' + server.address().port) 
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


function prtSummary(inid,resp_message,time,action){
   if(action == "MSG"){
      logger.info(">%d< [FIN-MSG] trx: %s, cmd: %s, token: %s, ex_time: %ss %sms",
                   inid,resp_message.trx,resp_message.cmd,resp_message.token_no,time[0],time[1]/1000000)
   }else if (action == "RESP"){
      logger.info(">%d< [FIN-RESP] trx: %s, cmd: %s, token: %s, res_code: %s, desc: %s, ex_time: %ss %sms",
                   inid,resp_message.trx,resp_message.cmd,resp_message.token_no,resp_message.res_code,resp_message.res_desc,time[0],time[1]/1000000)
   }
   
}

Array.prototype.myFind = function(obj) {
   return this.filter(function(item) {
      for (var prop in obj)
         if (!(prop in item) || obj[prop] !== item[prop])
              return false;
      return true;
   });
};