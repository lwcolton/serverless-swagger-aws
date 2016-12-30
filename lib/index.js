'use strict';

const SwaggerParser = require('swagger-parser');

function isWriteMethod(method){
  var methodName = method.toUpperCase()
  if(["GET", "HEAD", "OPTIONS"].indexOf(methodName)){
    return false;
  }
  return true;
}

class ServerlessSwagger {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.hooks = {
      "after:deploy:initialize":this.afterInitialize.bind(this),
      "before:deploy:deploy":this.beforeDeploy.bind(this)
    };
  }

  afterInitialize() {
    const naming = this.serverless.providers.aws.naming;
    var serverless = this.serverless;
    this.modelSchemas = {};
    var modelSchemas = this.modelSchemas;
    this.endpointRequestModels = {};
    var endpointRequestModels = this.endpointRequestModels;
    return new Promise(function(resolve, reject) {
      SwaggerParser.dereference("swagger.yaml")
        .then(function(swagger) {
          for (var urlPath in swagger.paths) {
            var resource = swagger.paths[urlPath];
            for (var method in resource) {
              var endpoint = resource[method];
              if (!endpoint.consumes && isWriteMethod(method)) {
                var errorMessage = "Resource " +
                  urlPath + " must define 'consumes' property for method" +
                  methodName;
                throw new Error(errorMessage);
              }
              var consumesJSON = false;
              for (var consumes in endpoint.consumes) {
                if (endpoint.consumes.includes("application/json")) {
                  consumesJSON = true;
                }
              }
              var slsUrlPath = urlPath.substring(1,urlPath.length);
              var methodName = method.toUpperCase();
              var paramsLength = endpoint.parameters.length;
              var endpointParam;
              var bodyParam = null;
              for (var paramNum = 0; paramNum < paramsLength; paramNum++) {
                endpointParam = endpoint.parameters[paramNum];
                if (endpointParam.in == "body") {
                  bodyParam = endpointParam;
                  break;
                }
              }
              if (consumesJSON) {
                if (!bodyParam) {
                  var errorMessage = "Resource " + urlPath +
                    " must define body for method " + methodName;
                  throw new Error(errorMessage);
                }
                if (!bodyParam.schema) {
                  throw new Error("Must specify schema for JSON request body.  " +
                    "Endpoint: " + methodName + " " + urlPath)
                }
                var modelName = "RequestBody" + methodName + naming.normalizePath(urlPath);
                if (modelSchemas[modelName]){
                  throw new Error("Conflicting models for name '" + modelName +
                  "'.  Endpoint: " + methodName + " " + urlPath)
                }
                modelSchemas[modelName] = bodyParam.schema;
                if(!endpointRequestModels[slsUrlPath]){
                  endpointRequestModels[slsUrlPath] = {};
                }
                endpointRequestModels[slsUrlPath][method] = modelName;
              }
              var slsConfig = endpoint["x-serverless"];
              if (!slsConfig) {
                throw new Error("No 'x-serverless' property defined for " +
                  methodName + " " + urlPath);
              }

              if(!slsConfig.functionName){
                throw new Error("Property 'functionName' is required under" +
                  "'x-serverless'.  Endpoint " + methodName + " " + path)
              }
              if(!slsConfig.lambdaProxy){
                var integrationMethod = "lambda"
              } else {
                var integrationMethod = "lambda-proxy"
              }
              var slsEvent = {
                "http":{
                  "path": slsUrlPath,
                  "method": method,
                  "integration": integrationMethod
                }
              }
              var existingFunction = serverless.service.functions[slsConfig.functionName];
              if(!existingFunction){
                if(!slsConfig.function){
                  throw new Error("Property 'function' is required" +
                    "undex x-serverless.  " + "Endpoint " + methodName + " " + urlPath)
                }
                slsConfig.function.events = [slsEvent]
                serverless.service.functions[slsConfig.functionName] = slsConfig.function;
              } else {
                if(slsConfig.function){
                  throw new Error("Config for function '" + slsConfig.functionName +
                    "' already exists.  Endpoint: " + methodName + " " + urlPath)
                }
                if(!existingFunction.events){
                  existingFunction.events = [slsEvent]
                } else {
                  existingFunction.events.push(slsEvent)
                }
              }
            }
            resolve();
          }
        })
        .catch(function(err) {
          reject(err);
        });
    });
  }

  beforeDeploy() {
    const naming = this.serverless.providers.aws.naming;
    var cloudFormationTemplate = this.serverless.service.provider.compiledCloudFormationTemplate;
    for (var slsUrlPath in this.endpointRequestModels) {
      var resource = this.endpointRequestModels[slsUrlPath];
      for (var method in resource) {
        var modelName = resource[method];
        var endpointResourceName = naming.normalizePath(slsUrlPath);
        var endpointLogicalId = naming.getMethodLogicalId(endpointResourceName, method);
        var cloudFormationMethod = cloudFormationTemplate.Resources[endpointLogicalId];
        cloudFormationMethod.Properties.RequestModels = {
          "application/json":modelName
        }
        var restApiId = cloudFormationMethod.Properties.RestApiId;
        var modelResourceName = "ApiGatewayModel" + modelName;
        var schema = this.modelSchemas[modelName];
        var model = {
          "Type":"AWS::ApiGateway::Model",
          "Properties":{
            "Schema":schema,
            "RestApiId":restApiId,
            "Name":modelName,
            "ContentType":"application/json"
          }
        };
        cloudFormationTemplate.Resources[modelResourceName] = model;
      }
    }
  }
}

module.exports = ServerlessSwagger;
