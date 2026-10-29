// Line-delimited JSON bridge. stdout is reserved for protocol responses.
#include <opendaq/opendaq.h>
#include <opendaq/reader_factory.h>
#include <opendaq/stream_reader_builder_ptr.h>
#include <rapidjson/document.h>
#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>
#include <algorithm>
#include <cmath>
#include <iostream>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>

using namespace daq;
using J = rapidjson::Value;
using A = rapidjson::Document::AllocatorType;
static J str(const std::string& s, A& a) { return J(s.c_str(), static_cast<rapidjson::SizeType>(s.size()), a); }
static std::string txt(const StringPtr& s) { return s.assigned() ? s.toStdString() : ""; }
static void put(J& o, const char* k, J v, A& a) { o.AddMember(str(k,a), v, a); }
static std::string field(const J& j, const char* k) {
    if (!j.HasMember(k) || !j[k].IsString()) throw std::runtime_error(std::string("Missing string: ")+k);
    return j[k].GetString();
}
static J valueJson(const BaseObjectPtr& v, A& a, int depth=0) {
    if (!v.assigned()) return J();
    if (depth>6) return str(v.toString(),a);
    switch (v.getCoreType()) {
        case ctBool: return J(static_cast<bool>(BoolPtr(v)));
        case ctInt: return J(static_cast<int64_t>(IntPtr(v)));
        case ctFloat: { double n=FloatPtr(v); return std::isfinite(n) ? J(n) : J(); }
        case ctString: return str(txt(v.asPtr<IString>()),a);
        case ctList: { J r(rapidjson::kArrayType); for (const auto& x : v.asPtr<IList>()) r.PushBack(valueJson(x,a,depth+1),a); return r; }
        default: return str(v.toString(),a);
    }
}
class Workstation {
    InstancePtr instance;
    std::map<std::string, StreamReaderPtr> readers;
    ComponentPtr component(const std::string& id) {
        if (id==txt(instance.getGlobalId()) || id.empty()) return instance;
        auto c=instance.findComponent(id);
        if (!c.assigned()) throw std::runtime_error("Component no longer exists: "+id);
        return c;
    }
    J node(const ComponentPtr& c, const char* kind, A& a) {
        J n(rapidjson::kObjectType);
        put(n,"id",str(txt(c.getGlobalId()),a),a); put(n,"name",str(txt(c.getName()),a),a);
        put(n,"kind",str(kind,a),a); put(n,"description",str(txt(c.getDescription()),a),a);
        return n;
    }
    void appendDevice(const DevicePtr& dev, J& nodes, A& a) {
        auto n=node(dev,"device",a); auto info=dev.getInfo();
        put(n,"connection",str(txt(info.getConnectionString()),a),a);
        put(n,"serial",str(txt(info.getSerialNumber()),a),a); nodes.PushBack(n,a);
        for (const auto& c:dev.getChannels()) nodes.PushBack(node(c,"channel",a),a);
        for (const auto& sub:dev.getDevices()) appendDevice(sub,nodes,a);
    }
public:
    explicit Workstation(const char* path) {
        auto logger=LoggerWithSinks(List<ILoggerSink>(StdErrLoggerSink()),LogLevel::Warn);
        instance=InstanceFromBuilder(InstanceBuilder().setModulePath(path).setLogger(logger).setDefaultRootDeviceLocalId("daq-web"));
    }
    J run(const J& req,A& a) {
        const auto op=field(req,"op"); J out(rapidjson::kObjectType);
        if(op=="state") {
            put(out,"root",str(txt(instance.getGlobalId()),a),a);
            J nodes(rapidjson::kArrayType); nodes.PushBack(node(instance,"instance",a),a);
            for(const auto& d:instance.getDevices()) appendDevice(d,nodes,a);
            J signals(rapidjson::kArrayType);
            for(const auto& s:instance.getSignalsRecursive()) {
                auto n=node(s,"signal",a); auto dd=s.getDescriptor();
                put(n,"public",J(static_cast<bool>(s.getPublic())),a);
                if(dd.assigned()) {
                    put(n,"sampleType",J(static_cast<int>(dd.getSampleType())),a);
                    auto u=dd.getUnit(); put(n,"unit",str(u.assigned()?txt(u.getSymbol()):"",a),a);
                }
                signals.PushBack(n,a);
            }
            J blocks(rapidjson::kArrayType);
            for(const auto& b:instance.getFunctionBlocks()) {
                auto n=node(b,"block",a); J ports(rapidjson::kArrayType);
                for(const auto& p:b.getInputPorts()) {
                    auto q=node(p,"port",a); auto s=p.getSignal(); put(q,"signal",str(s.assigned()?txt(s.getGlobalId()):"",a),a); ports.PushBack(q,a);
                }
                put(n,"ports",std::move(ports),a); blocks.PushBack(n,a); nodes.PushBack(node(b,"block",a),a);
            }
            J types(rapidjson::kArrayType);
            for(const auto& key:instance.getAvailableFunctionBlockTypes().getKeyList()) {
                auto t=instance.getAvailableFunctionBlockTypes().get(key); J n(rapidjson::kObjectType);
                put(n,"id",str(txt(key),a),a); put(n,"name",str(txt(t.getName()),a),a); types.PushBack(n,a);
            }
            put(out,"nodes",std::move(nodes),a); put(out,"signals",std::move(signals),a);
            put(out,"blocks",std::move(blocks),a); put(out,"blockTypes",std::move(types),a);
        } else if(op=="scan") {
            J devices(rapidjson::kArrayType);
            for(const auto& d:instance.getAvailableDevices()) {
                J n(rapidjson::kObjectType); put(n,"name",str(txt(d.getName()),a),a);
                put(n,"connection",str(txt(d.getConnectionString()),a),a); put(n,"serial",str(txt(d.getSerialNumber()),a),a);
                devices.PushBack(n,a);
            } put(out,"devices",std::move(devices),a);
        } else if(op=="connect") {
            auto config=instance.createDefaultAddDeviceConfig();
            if(req.HasMember("username")) {
                PropertyObjectPtr general=config.getPropertyValue("General");
                general.setPropertyValue("Username",field(req,"username"));
                general.setPropertyValue("Password",field(req,"password"));
            }
            auto d=instance.addDevice(field(req,"connection"),config); put(out,"id",str(txt(d.getGlobalId()),a),a);
        } else if(op=="disconnect") {
            auto d=component(field(req,"id")).asPtr<IDevice>();
            auto id=txt(d.getGlobalId());
            for(auto i=readers.begin();i!=readers.end();) { if(i->first.compare(0,id.size(),id)==0) i=readers.erase(i); else ++i; }
            instance.removeDevice(d);
        } else if(op=="properties") {
            auto obj=component(field(req,"id")).asPtr<IPropertyObject>(); J props(rapidjson::kArrayType);
            for(const auto& p:obj.getVisibleProperties()) {
                J n(rapidjson::kObjectType); put(n,"name",str(txt(p.getName()),a),a); put(n,"type",J(static_cast<int>(p.getValueType())),a);
                put(n,"readOnly",J(static_cast<bool>(p.getReadOnly())),a); put(n,"description",str(txt(p.getDescription()),a),a);
                try { put(n,"value",valueJson(obj.getPropertyValue(p.getName()),a),a); } catch(const std::exception& e) { put(n,"error",str(e.what(),a),a); }
                auto opts=p.getSelectionValues(); if(opts.assigned()) put(n,"selection",valueJson(opts,a),a);
                auto lo=p.getMinValue(); if(lo.assigned()) put(n,"min",valueJson(lo,a),a);
                auto hi=p.getMaxValue(); if(hi.assigned()) put(n,"max",valueJson(hi,a),a);
                props.PushBack(n,a);
            } put(out,"properties",std::move(props),a);
        } else if(op=="set") {
            auto obj=component(field(req,"id")).asPtr<IPropertyObject>(); auto name=field(req,"name"); auto p=obj.getProperty(name);
            if(p.getReadOnly()) throw std::runtime_error("Property is read-only");
            if(!req.HasMember("value")) throw std::runtime_error("Missing property value");
            const auto& v=req["value"]; BaseObjectPtr value;
            switch(p.getValueType()) {
                case ctBool: if(!v.IsBool()) throw std::runtime_error("Expected boolean"); value=Boolean(v.GetBool()); break;
                case ctInt: if(!v.IsInt64()) throw std::runtime_error("Expected integer"); value=Integer(v.GetInt64()); break;
                case ctFloat: if(!v.IsNumber()) throw std::runtime_error("Expected number"); value=Float(v.GetDouble()); break;
                case ctString: if(!v.IsString()) throw std::runtime_error("Expected string"); value=String(v.GetString()); break;
                default: throw std::runtime_error("This property type is inspection-only");
            } obj.setPropertyValue(name,value);
            put(out,"value",valueJson(obj.getPropertyValue(name),a),a);
        } else if(op=="subscribe") {
            if(!req.HasMember("signals") || !req["signals"].IsArray()) throw std::runtime_error("Expected signal list");
            if(req["signals"].Size()>16) throw std::runtime_error("Select at most 16 signals");
            std::map<std::string,StreamReaderPtr> next;
            for(const auto& v:req["signals"].GetArray()) {
                if(!v.IsString()) throw std::runtime_error("Invalid signal id"); std::string id=v.GetString();
                auto s=component(id).asPtr<ISignal>();
                auto dd=s.getDescriptor();
                if(!dd.assigned() || dd.getDimensions().getCount()!=0) throw std::runtime_error("Only scalar numeric signals are supported");
                next[id]=StreamReaderBuilder().setSignal(s).setValueReadType(SampleType::Float64).setDomainReadType(SampleType::Int64).setSkipEvents(true).build();
            } readers.swap(next);
        } else if(op=="samples") {
            J batches(rapidjson::kArrayType);
            for(auto& item:readers) {
                J b(rapidjson::kObjectType); put(b,"id",str(item.first,a),a);
                try {
                    std::vector<double> values(8192); std::vector<Int> domain(8192); SizeT count=values.size();
                    auto status=item.second.readWithDomain(values.data(),domain.data(),&count,0);
                    if(status.assigned() && !status.getValid()) throw std::runtime_error("Signal descriptor changed or reader became invalid; restart acquisition");
                    J ys(rapidjson::kArrayType),xs(rapidjson::kArrayType);
                    for(SizeT i=0;i<count;++i) { ys.PushBack(std::isfinite(values[i])?J(values[i]):J(),a); xs.PushBack(str(std::to_string(domain[i]),a),a); }
                    put(b,"values",std::move(ys),a); put(b,"ticks",std::move(xs),a);
                    auto signal=component(item.first).asPtr<ISignal>(); auto ds=signal.getDomainSignal();
                    if(ds.assigned() && ds.getDescriptor().assigned()) {
                        auto dd=ds.getDescriptor(); auto r=dd.getTickResolution();
                        if(r.assigned()) { put(b,"tickNumerator",str(std::to_string(r.getNumerator()),a),a); put(b,"tickDenominator",str(std::to_string(r.getDenominator()),a),a); }
                        put(b,"origin",str(txt(dd.getOrigin()),a),a);
                    }
                    put(b,"pending",J(static_cast<uint64_t>(item.second.getAvailableCount())),a);
                } catch(const std::exception& e) { put(b,"error",str(e.what(),a),a); }
                batches.PushBack(b,a);
            } put(out,"batches",std::move(batches),a);
        } else if(op=="block_add") {
            auto b=instance.addFunctionBlock(field(req,"type")); put(out,"id",str(txt(b.getGlobalId()),a),a);
        } else if(op=="block_remove") {
            readers.clear(); instance.removeFunctionBlock(component(field(req,"id")).asPtr<IFunctionBlock>());
        } else if(op=="port_connect") {
            component(field(req,"port")).asPtr<IInputPort>().connect(component(field(req,"signal")).asPtr<ISignal>());
        } else if(op=="port_disconnect") {
            component(field(req,"port")).asPtr<IInputPort>().disconnect();
        } else if(op=="config_save") {
            put(out,"configuration",str(txt(instance.saveConfiguration()),a),a);
        } else if(op=="config_load") {
            readers.clear(); instance.loadConfiguration(field(req,"configuration"));
        } else if(op=="stop") { readers.clear(); }
        else throw std::runtime_error("Unknown operation: "+op);
        return out;
    }
};
int main(int argc,char** argv) {
    try {
        Workstation app(argc>1?argv[1]:".");
        std::string line;
        while(std::getline(std::cin,line)) {
            rapidjson::Document doc; doc.Parse(line.c_str()); auto& a=doc.GetAllocator(); J reply(rapidjson::kObjectType);
            try {
                if(doc.HasParseError() || !doc.IsObject()) throw std::runtime_error("Invalid JSON request");
                auto result=app.run(doc,a); put(reply,"ok",J(true),a); put(reply,"result",std::move(result),a);
            } catch(const std::exception& e) { put(reply,"ok",J(false),a); put(reply,"error",str(e.what(),a),a); }
            rapidjson::StringBuffer buffer; rapidjson::Writer<rapidjson::StringBuffer> writer(buffer); reply.Accept(writer);
            std::cout << buffer.GetString() << std::endl;
        }
    } catch(const std::exception& e) { std::cerr << e.what() << std::endl; return 1; }
}
